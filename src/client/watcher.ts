/**
 * 浏览器端通知运行时：订阅宿主的 mux / host 事件流，驱动通知状态机，
 * 并按实时配置投递通知。
 *
 * 为什么客户端要自己再开一对流？客户端 runtime 的 `ctx.connection.start()`
 * 独占的一对流只喂给它内部的 SessionRuntime，普通插件拿不到原始帧；而
 * 宿主 mux/host 流的实现是多订阅者的（每次调用独立建队列与监听器），因此
 * 插件可以并开一对属于自己的流，拿到与宿主侧完全一致的 `session/event`
 * 透传帧（含 `turn/end` 原因、`tool/call`、`approval/asked`）和
 * `host/session-status` 运行翻转帧。
 *
 * 子代理会话的排除与标题解析走 `ctx.sessions.list` 快照（origin/title 行
 * 字段由客户端 runtime 维护，零额外流量）。
 */
import type { NotificationBackend } from './backend'
import type { SettingsScope, SettingsScopeSnapshot } from './index'
import { blockedBody, buildBody, clipTitle, resultText } from '../notify.js'
import { BlockedNotifier, RunEndNotifier } from '../notifier.js'
import type { SessionEvent } from '../types.js'

/** 解析后的通知配置（schema 默认值 + 组合层 + 用户层已合入 section 值）。 */
export interface ResolvedNotificationConfig {
  enabled: boolean
  title: string
  sound: boolean
  onBlocked: boolean
  onQuestion: boolean
  onApproval: boolean
}

/** 与宿主侧 Config schema 默认值保持一致。 */
const DEFAULTS: ResolvedNotificationConfig = {
  enabled: true,
  title: 'DeepSeek Harness',
  sound: true,
  onBlocked: true,
  onQuestion: true,
  onApproval: true,
}

function boolOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 从设置作用域快照解析权威配置；section 未就绪时全部取默认值。 */
export function resolveConfig(snapshot: SettingsScopeSnapshot): ResolvedNotificationConfig {
  const value = snapshot.value ?? {}
  return {
    enabled: boolOf(value.enabled, DEFAULTS.enabled),
    title: typeof value.title === 'string' && value.title !== '' ? value.title : DEFAULTS.title,
    sound: boolOf(value.sound, DEFAULTS.sound),
    onBlocked: boolOf(value.onBlocked, DEFAULTS.onBlocked),
    onQuestion: boolOf(value.onQuestion, DEFAULTS.onQuestion),
    onApproval: boolOf(value.onApproval, DEFAULTS.onApproval),
  }
}

/** 本运行时读取的 mux 帧成员（其余帧一律忽略）。 */
export type MuxFrame =
  | { type: 'session/event'; sessionId: string; event: SessionEvent }
  | { type: string }

/** 本运行时读取的 host 帧成员（其余帧一律忽略）。 */
export type HostFrame =
  | { type: 'host/session-status'; sessionId: string; running: boolean }
  | { type: string }

/** 宿主事件流 API 的最小结构化类型（帧包在 rpcId 信封里下发）。 */
export interface EventsFace {
  mux(payload: Record<string, never>, signal: AbortSignal): AsyncIterable<{ payload: MuxFrame }>
  host(payload: Record<string, never>, signal: AbortSignal): AsyncIterable<{ payload: HostFrame }>
}

/** 会话列表快照中本运行时读取的行字段。 */
export interface SessionListRow {
  origin?: 'subagent'
  title?: string
  running?: boolean
}

/** `ctx.sessions` 服务的最小结构化类型。 */
export interface SessionsFace {
  list: {
    getSnapshot(): { byId: Record<string, SessionListRow | undefined> }
  }
}

/** 断流重连的等待间隔。 */
const RECONNECT_DELAY_MS = 3000

/**
 * idle 翻转后等待迟到 turn/end 的宽限窗口。mux 与 host 是两条独立的
 * WebSocket，帧间没有顺序保证：运行结束时 `host/session-status(running:
 * false)` 可能先于同刻的 `turn/end` 到达（实测如此），立即判定「无可
 * 汇报」会丢掉通知，因此空闲信号先挂起一个宽限窗口。
 */
const IDLE_GRACE_MS = 1500

/** 可中断的睡眠；abort 时提前 resolve。 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 通知 watcher：持有两个状态机与「正在运行」会话集合，把 mux/host 帧翻译
 * 成通知。通过 {@link start} 启动并拿到销毁函数。
 */
export class NotificationWatcher {
  private readonly runEnd = new RunEndNotifier({
    notify: (kind, sessionId) => { this.emitRunEnd(kind, sessionId) },
  })
  private readonly blocked = new BlockedNotifier({
    notify: (kind, detail, sessionId) => { this.emitBlocked(kind, detail, sessionId) },
  })
  /** 当前处于 running 的会话；running 由 true 翻 false 即运行结束。 */
  private readonly running = new Set<string>()
  /** 等待迟到 turn/end 的挂起空闲信号（会话 id → 定时器）。 */
  private readonly pendingIdle = new Map<string, ReturnType<typeof setTimeout>>()
  /** 宽限窗口（可注入以方便测试）。 */
  private readonly idleGraceMs: number

  constructor(private readonly deps: {
    scope: SettingsScope
    sessions: SessionsFace
    events: EventsFace
    backend: NotificationBackend
    /** 可选的诊断日志回调（E2E 验证用，定位「没收到通知」的断点）。 */
    log?: (message: string) => void
    /** idle 宽限窗口毫秒数；缺省 {@link IDLE_GRACE_MS}。 */
    idleGraceMs?: number
  }) {
    this.idleGraceMs = deps.idleGraceMs ?? IDLE_GRACE_MS
  }

  private log(message: string): void {
    this.deps.log?.(message)
  }

  /**
   * 启动两条订阅循环（断流后自动重连），返回销毁函数。
   * @returns 中止两条订阅的销毁函数。
   */
  start(): () => void {
    const controller = new AbortController()
    this.seedRunning()
    void this.loop('mux', controller.signal)
    void this.loop('host', controller.signal)
    return () => {
      controller.abort()
      for (const timer of this.pendingIdle.values()) clearTimeout(timer)
      this.pendingIdle.clear()
    }
  }

  /** 以会话列表快照为基线播种 running 集合（每次重连后重播）。 */
  private seedRunning(): void {
    this.running.clear()
    const byId = this.deps.sessions.list.getSnapshot().byId
    for (const [id, row] of Object.entries(byId)) {
      if (row?.running) this.running.add(id)
    }
  }

  /** 单条流的订阅循环：迭代到断流/出错，等待后重开，直到被 abort。 */
  private async loop(stream: 'mux' | 'host', signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      this.log(`${stream}: open`)
      try {
        for await (const envelope of this.deps.events[stream]({}, signal)) {
          if (stream === 'mux') this.onMuxFrame(envelope.payload as MuxFrame)
          else this.onHostFrame(envelope.payload as HostFrame)
        }
      } catch (error) {
        this.log(`${stream}: error ${String(error)}`)
      }
      if (signal.aborted) return
      this.log(`${stream}: closed, reconnecting`)
      await delay(RECONNECT_DELAY_MS, signal)
      this.seedRunning()
    }
  }

  /** 处理一条 mux 帧：根会话的会话事件喂给两个状态机。 */
  onMuxFrame(frame: MuxFrame): void {
    if (frame.type !== 'session/event') return
    const { sessionId, event } = frame as { sessionId: string; event: SessionEvent }
    if (event.type === 'turn/end' || event.type === 'tool/call' || event.type === 'approval/asked') {
      this.log(`mux ${event.type} @${sessionId}${this.isSubagent(sessionId) ? ' (subagent)' : ''}`)
    }
    if (this.isSubagent(sessionId)) return
    this.runEnd.onSessionEvent(sessionId, event)
    this.blocked.onSessionEvent(sessionId, event)
    // 迟到的 turn/end 落进挂起的空闲窗口：立即汇报，不再等宽限到期。
    if (event.type === 'turn/end' && this.pendingIdle.has(sessionId)) {
      this.settleIdle(sessionId, 'turn/end arrived in grace window')
    }
  }

  /** 处理一条 host 帧：running 由 true 翻 false 时汇报运行结果。 */
  onHostFrame(frame: HostFrame): void {
    if (frame.type !== 'host/session-status') return
    const { sessionId, running } = frame as { sessionId: string; running: boolean }
    this.log(`host running=${running} @${sessionId} tracked=${this.running.has(sessionId)}`)
    if (running) {
      this.running.add(sessionId)
      this.runEnd.onRunStart(sessionId)
      return
    }
    if (!this.running.delete(sessionId)) return // 未见其运行，无可汇报
    if (this.isSubagent(sessionId)) return
    if (this.runEnd.hasReason(sessionId)) {
      this.runEnd.onIdle(sessionId)
      return
    }
    // turn/end 可能还在另一条流上：挂起宽限窗口，到期再定夺。
    this.log(`idle @${sessionId} pending grace ${this.idleGraceMs}ms`)
    clearTimeout(this.pendingIdle.get(sessionId))
    this.pendingIdle.set(sessionId, setTimeout(() => {
      this.settleIdle(sessionId, 'grace expired')
    }, this.idleGraceMs))
  }

  /** 结算一个挂起的空闲信号：原因已到则汇报，仍未到则丢弃并清理。 */
  private settleIdle(sessionId: string, why: string): void {
    clearTimeout(this.pendingIdle.get(sessionId))
    this.pendingIdle.delete(sessionId)
    if (this.runEnd.hasReason(sessionId)) {
      this.log(`idle @${sessionId} settled: ${why}`)
      this.runEnd.onIdle(sessionId)
    } else {
      this.log(`idle @${sessionId} dropped: ${why}, no turn/end recorded`)
    }
  }

  /** 子代理会话（harness 惯例 `origin === 'subagent'`）不产生通知。 */
  private isSubagent(sessionId: string): boolean {
    return this.row(sessionId)?.origin === 'subagent'
  }

  private row(sessionId: string): SessionListRow | undefined {
    return this.deps.sessions.list.getSnapshot().byId[sessionId]
  }

  private config(): ResolvedNotificationConfig {
    return resolveConfig(this.deps.scope.getSnapshot())
  }

  /** 运行结束通知：总开关把关，正文携带结果文案与最新标题。 */
  private async emitRunEnd(kind: string, sessionId: string): Promise<void> {
    const config = this.config()
    if (!config.enabled) {
      this.log(`run-end ${kind} @${sessionId} muted`)
      return
    }
    if (await this.deps.backend.isAppInForeground()) {
      this.log(`notify suppressed (app in foreground)`)
      return
    }
    const body = buildBody(resultText(kind), clipTitle(this.row(sessionId)?.title))
    this.log(`notify run-end: ${body} @${sessionId}`)
    void this.deps.backend.notify({ title: config.title, body, silent: !config.sound })
      .then((sent) => { this.log(sent ? 'notify delivered' : 'notify skipped (permission)') }, (error: unknown) => { this.log(`notify error ${String(error)}`) })
  }

  /** 阻塞式交互通知：onBlocked/onQuestion/onApproval 分层把关。 */
  private async emitBlocked(kind: string, detail: string, sessionId: string): Promise<void> {
    const config = this.config()
    if (!config.enabled || !config.onBlocked) return
    if (kind === 'question' && !config.onQuestion) return
    if (kind === 'approval' && !config.onApproval) return
    if (await this.deps.backend.isAppInForeground()) {
      this.log(`notify suppressed (app in foreground)`)
      return
    }
    const body = blockedBody(kind, detail, sessionId, clipTitle(this.row(sessionId)?.title))
    this.log(`notify blocked: ${body}`)
    void this.deps.backend.notify({ title: config.title, body, silent: !config.sound })
      .then((sent) => { this.log(sent ? 'notify delivered' : 'notify skipped (permission)') }, (error: unknown) => { this.log(`notify error ${String(error)}`) })
  }
}
