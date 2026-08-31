/**
 * 由会话事件流驱动的通知状态机。
 *
 * 为什么不直接在 `turn/end` 时通知？一次「运行」可能跨越多个 turn：
 * 目标运行（goal run）每个 turn 排队一轮，而每一轮的 `turn/end` 都携带
 * 相同的 `completed` 类型。按 turn 通知会导致每轮刷一条通知，并在运行
 * 仍在进行时就播报「任务已完成」。harness 本身把 `agent/status` 的
 * `'idle'` 当作运行结束的信号（网页宿主据此翻转运行指示器，`whenIdle()`
 * 也在静止时 resolve），因此本通知器等待运行静止（浏览器端表现为
 * `host/session-status` 的 running 由 true 翻转为 false），并汇报*最近
 * 一次*记录的 `turn/end` 原因——每次运行只发一条通知，且携带真正的最终
 * 结果。
 *
 * 状态机只按会话 id 工作：子代理会话的排除和会话标题的解析都由调用方
 * （浏览器端的 watcher）负责，它持有会话列表快照。
 */
import { approvalDetail, blockedQuestionText } from './notify.js'
import type { ApprovalAskedData, SessionEvent, ToolCallData } from './types.js'

/**
 * 跟踪每个根会话的 turn 结束，并在运行回到静止时，恰好一次地汇报最终
 * 结果。
 */
export class RunEndNotifier {
  /** 每个根会话 id 最近一次 `turn/end` 的原因类型，在静止时消费。 */
  private readonly reasons = new Map<string, string>()

  constructor(private readonly deps: {
    /** 为一次已结束的根运行发出一条通知。 */
    notify: (kind: string, sessionId: string) => unknown
  }) {}

  /** 接收一条会话事件；记录该会话最近一次 turn 结束的原因类型。 */
  onSessionEvent(sessionId: string, event: SessionEvent): void {
    if (event.type !== 'turn/end') return
    const data = event.data as { reason?: { kind?: unknown } } | undefined
    const kind = typeof data?.reason?.kind === 'string' ? data.reason.kind : 'unknown'
    this.reasons.set(sessionId, kind)
  }

  /** 该会话是否有已记录、待汇报的 turn 结束原因。 */
  hasReason(sessionId: string): boolean {
    return this.reasons.has(sessionId)
  }

  /**
   * 新一轮运行开始：清掉上一轮可能残留的原因（上一轮的空闲信号因事件流
   * 乱序先于 turn/end 到达而未能汇报时，残留绝不能张冠李戴到这一轮）。
   */
  onRunStart(sessionId: string): void {
    this.reasons.delete(sessionId)
  }

  /** 运行进入静止时，一次性汇报已记录的结果；本次活动没有 turn 结束则跳过。 */
  onIdle(sessionId: string): void {
    const kind = this.reasons.get(sessionId)
    if (kind === undefined) return
    this.reasons.delete(sessionId)
    this.deps.notify(kind, sessionId)
  }
}

/**
 * 每当发生一次阻塞式用户交互就发出一条通知：提问（`tool/call` 中名为
 * `ask_user_question`）或审批请求（`approval/asked`）。与
 * {@link RunEndNotifier} 不同，它在每个事件发生时立即汇报——不做聚合——
 * 因为每一次询问都是独立的「会话正在等待用户」时刻。
 *
 * onBlocked/onQuestion/onApproval 开关在调用方的 notify 回调中动态判断
 * （取自实时的设置/入口配置），因此本类会汇报它看到的每一个阻塞事件。
 */
export class BlockedNotifier {
  constructor(private readonly deps: {
    /** 为一次阻塞动作发出一条通知。 */
    notify: (kind: string, detail: string, sessionId: string) => unknown
  }) {}

  /** 接收一条会话事件；仅汇报阻塞式交互。 */
  onSessionEvent(sessionId: string, event: SessionEvent): void {
    if (event.type === 'tool/call') {
      const data = event.data as ToolCallData | undefined
      if (data?.name !== 'ask_user_question') return
      const detail = typeof data.arguments === 'string' ? blockedQuestionText(data.arguments) : ''
      this.deps.notify('question', detail, sessionId)
    } else if (event.type === 'approval/asked') {
      const data = event.data as ApprovalAskedData | undefined
      const toolName = typeof data?.toolName === 'string' ? data.toolName : ''
      const reason = typeof data?.reason === 'string' ? data.reason : ''
      this.deps.notify('approval', approvalDetail(toolName, reason), sessionId)
    }
  }
}
