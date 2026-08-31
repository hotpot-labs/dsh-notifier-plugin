import { describe, expect, it, vi } from 'vitest'
import type { NotificationBackend, NotificationRequest } from '../src/client/backend'
import type { SettingsScope, SettingsScopeSnapshot } from '../src/client/index'
import { NotificationWatcher, resolveConfig } from '../src/client/watcher.js'
import type { EventsFace, HostFrame, MuxFrame, SessionListRow } from '../src/client/watcher.js'

function makeScope(value: Record<string, unknown> | undefined): SettingsScope {
  const snapshot: SettingsScopeSnapshot = {
    status: 'ready',
    value,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async () => {},
    unset: async () => {},
  }
}

/** 阻塞到 abort 的空流：start() 的两条订阅循环挂在这里，不产生任何帧。 */
function neverStream(signal: AbortSignal): AsyncIterable<never> {
  return (async function* () {
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  })()
}

function makeFixture(options: {
  value?: Record<string, unknown>
  rows?: Record<string, SessionListRow>
  idleGraceMs?: number
  foreground?: boolean
}) {
  const requests: NotificationRequest[] = []
  const logs: string[] = []
  const backend: NotificationBackend = {
    ensurePermission: async () => true,
    notify: vi.fn(async (request: NotificationRequest) => { requests.push(request); return true }),
    isAppInForeground: async () => options.foreground ?? false,
  }
  const events: EventsFace = {
    mux: (_payload, signal) => neverStream(signal),
    host: (_payload, signal) => neverStream(signal),
  }
  const watcher = new NotificationWatcher({
    scope: makeScope(options.value),
    sessions: { list: { getSnapshot: () => ({ byId: options.rows ?? {} }) } },
    events,
    backend,
    log: message => { logs.push(message) },
    ...options.idleGraceMs === undefined ? {} : { idleGraceMs: options.idleGraceMs },
  })
  return { watcher, requests, logs, notify: backend.notify }
}

/** 等 emit 方法里的 isAppInForeground 查询（一个宏任务足够）。 */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function turnEnd(sessionId: string, kind: string): MuxFrame {
  return { type: 'session/event', sessionId, event: { type: 'turn/end', data: { reason: { kind } } } }
}

function statusFlip(sessionId: string, running: boolean): HostFrame {
  return { type: 'host/session-status', sessionId, running }
}

describe('resolveConfig', () => {
  it('falls back to defaults when the section carries no values', () => {
    expect(resolveConfig(makeScope(undefined).getSnapshot())).toEqual({
      enabled: true,
      title: 'DeepSeek Harness',
      sound: true,
      onBlocked: true,
      onQuestion: true,
      onApproval: true,
    })
  })

  it('picks up section values, tolerating wrong types', () => {
    const config = resolveConfig(makeScope({ enabled: false, title: '', sound: 'yes' }).getSnapshot())
    expect(config.enabled).toBe(false)
    expect(config.title).toBe('DeepSeek Harness') // 空串回退默认
    expect(config.sound).toBe(true) // 非布尔回退默认
  })
})

describe('NotificationWatcher', () => {
  it('fires a run-end notification on the running true→false flip', async () => {
    const { watcher, requests } = makeFixture({
      value: undefined,
      rows: { s1: { title: '修复登录bug' } },
    })
    watcher.onHostFrame(statusFlip('s1', true))
    watcher.onMuxFrame(turnEnd('s1', 'completed'))
    watcher.onHostFrame(statusFlip('s1', false))
    await flush()
    expect(requests).toEqual([{
      title: 'DeepSeek Harness',
      body: '任务已完成 - 任务：修复登录bug',
      silent: false,
    }])
  })

  it('does not fire when the flip was never preceded by a running phase', () => {
    const { watcher, requests } = makeFixture({ value: undefined })
    watcher.onMuxFrame(turnEnd('s1', 'completed'))
    watcher.onHostFrame(statusFlip('s1', false))
    expect(requests).toEqual([])
  })

  it('seeds the running set from the list snapshot on start', async () => {
    const { watcher, requests } = makeFixture({
      value: undefined,
      rows: { s1: { running: true, title: 'T' } },
    })
    const dispose = watcher.start()
    watcher.onMuxFrame(turnEnd('s1', 'error'))
    watcher.onHostFrame(statusFlip('s1', false))
    dispose()
    await flush()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body).toBe('任务失败 - 任务：T')
  })

  it('mutes everything when the master switch is off', () => {
    const { watcher, requests } = makeFixture({ value: { enabled: false } })
    watcher.onMuxFrame(turnEnd('s1', 'completed'))
    watcher.onHostFrame(statusFlip('s1', true))
    watcher.onHostFrame(statusFlip('s1', false))
    watcher.onMuxFrame({ type: 'session/event', sessionId: 's1', event: { type: 'approval/asked', data: { toolName: 'Bash' } } })
    expect(requests).toEqual([])
  })

  it('maps sound:false to a silent notification', async () => {
    const { watcher, requests } = makeFixture({ value: { sound: false, title: 'DSH' } })
    watcher.onHostFrame(statusFlip('s1', true))
    watcher.onMuxFrame(turnEnd('s1', 'completed'))
    watcher.onHostFrame(statusFlip('s1', false))
    await flush()
    expect(requests[0]).toMatchObject({ title: 'DSH', silent: true })
  })

  it('excludes subagent sessions on both paths', () => {
    const { watcher, requests } = makeFixture({
      value: undefined,
      rows: { sub: { origin: 'subagent' } },
    })
    watcher.onMuxFrame(turnEnd('sub', 'completed'))
    watcher.onHostFrame(statusFlip('sub', true))
    watcher.onHostFrame(statusFlip('sub', false))
    watcher.onMuxFrame({ type: 'session/event', sessionId: 'sub', event: { type: 'approval/asked', data: { toolName: 'Bash' } } })
    expect(requests).toEqual([])
  })

  it('fires blocking notifications immediately with the gate switches honored', async () => {
    const question = { type: 'tool/call', data: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ question: '选哪个？' }] }) } }
    const approval = { type: 'approval/asked', data: { toolName: 'Bash', reason: '越权' } }

    const open = makeFixture({ value: undefined, rows: { s1: { title: 'T' } } })
    open.watcher.onMuxFrame({ type: 'session/event', sessionId: 's1', event: question })
    open.watcher.onMuxFrame({ type: 'session/event', sessionId: 's1', event: approval })
    await flush()
    expect(open.requests.map(r => r.body)).toEqual(['需要回答：选哪个？ — T', '需要批准：Bash — 越权 — T'])

    const noQuestion = makeFixture({ value: { onQuestion: false } })
    noQuestion.watcher.onMuxFrame({ type: 'session/event', sessionId: 's1', event: question })
    await flush()
    expect(noQuestion.requests).toEqual([])

    const noBlocked = makeFixture({ value: { onBlocked: false } })
    noBlocked.watcher.onMuxFrame({ type: 'session/event', sessionId: 's1', event: approval })
    await flush()
    expect(noBlocked.requests).toEqual([])
  })

  it('ignores unrelated frames', () => {
    const { watcher, requests } = makeFixture({ value: undefined })
    watcher.onMuxFrame({ type: 'session/subscribed' })
    watcher.onHostFrame({ type: 'host/session-added' })
    expect(requests).toEqual([])
  })

  it('holds the idle flip for a late turn/end across the two streams', async () => {
    const { watcher, requests } = makeFixture({ value: undefined, idleGraceMs: 50 })
    watcher.onHostFrame(statusFlip('s1', true))
    // host 流的 idle 翻转先于 mux 流的 turn/end 到达（跨流乱序）
    watcher.onHostFrame(statusFlip('s1', false))
    expect(requests).toEqual([]) // 宽限窗口内暂不汇报
    watcher.onMuxFrame(turnEnd('s1', 'completed'))
    await flush()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body).toBe('任务已完成')
  })

  it('drops the idle flip when no turn/end arrives within the grace window', async () => {
    const { watcher, requests } = makeFixture({ value: undefined, idleGraceMs: 20 })
    watcher.onHostFrame(statusFlip('s1', true))
    watcher.onHostFrame(statusFlip('s1', false))
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(requests).toEqual([])
  })

  it('does not attribute a stale reason to the next run', async () => {
    const { watcher, requests } = makeFixture({ value: undefined, idleGraceMs: 20 })
    // 上一轮：turn/end 迟到，错过 idle 宽限后残留在状态机里
    watcher.onHostFrame(statusFlip('s1', true))
    watcher.onHostFrame(statusFlip('s1', false))
    await new Promise(resolve => setTimeout(resolve, 60))
    watcher.onMuxFrame(turnEnd('s1', 'error'))
    // 新一轮：running=true 清掉残留，本轮没有 turn/end 则不应误报
    watcher.onHostFrame(statusFlip('s1', true))
    watcher.onHostFrame(statusFlip('s1', false))
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(requests).toEqual([])
  })

  it('suppresses the run-end notification while the app is in the foreground', async () => {
    const { watcher, requests, logs } = makeFixture({ value: undefined, foreground: true })
    watcher.onHostFrame(statusFlip('s1', true))
    watcher.onMuxFrame(turnEnd('s1', 'completed'))
    watcher.onHostFrame(statusFlip('s1', false))
    await flush()
    expect(requests).toEqual([])
    expect(logs).toContain('notify suppressed (app in foreground)')
  })

  it('suppresses blocking notifications while the app is in the foreground', async () => {
    const { watcher, requests, logs } = makeFixture({ value: undefined, foreground: true })
    watcher.onMuxFrame({ type: 'session/event', sessionId: 's1', event: { type: 'approval/asked', data: { toolName: 'Bash' } } })
    await flush()
    expect(requests).toEqual([])
    expect(logs).toContain('notify suppressed (app in foreground)')
  })

  it('still notifies when the app is in the background', async () => {
    const { watcher, requests, logs } = makeFixture({ value: undefined, foreground: false })
    watcher.onHostFrame(statusFlip('s1', true))
    watcher.onMuxFrame(turnEnd('s1', 'completed'))
    watcher.onHostFrame(statusFlip('s1', false))
    await flush()
    expect(requests).toHaveLength(1)
    expect(logs).not.toContain('notify suppressed (app in foreground)')
  })
})
