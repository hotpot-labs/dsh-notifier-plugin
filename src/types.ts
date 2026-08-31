/**
 * harness `session/event` 事件流的结构化事件类型。
 * 刻意保持最小化：只包含本插件读取的字段，这样插件在运行时无需依赖
 * harness 的内部包。
 * @module dsh-notifier-plugin/types
 */

/**
 * harness 代理循环写入的 `turn/end` 原因类型。`blocked` 在步前门禁拒绝
 * 该 turn 时发出；`interrupted` 由持久化层在修复崩溃遗留的孤儿 turn 时
 * 写入。该映射是可合并扩展的，因此未知类型必须回退为通用的结束处理。
 */
export type TurnEndKind = 'completed' | 'error' | 'aborted' | 'max-tokens' | 'blocked' | 'interrupted'

/** 会话事件流中的一条事件（宿主 mux 流原样透传的结构）。 */
export interface SessionEvent {
  type: string
  data: unknown
}

/** 本插件读取的 `tool/call` 事件数据字段。 */
export interface ToolCallData {
  name?: unknown
  arguments?: unknown
}

/** 本插件读取的 `approval/asked` 事件数据字段。`reason` 可选。 */
export interface ApprovalAskedData {
  toolName?: unknown
  reason?: unknown
}
