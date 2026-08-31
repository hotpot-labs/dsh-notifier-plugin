/**
 * 结果文案映射与通知正文的构建。这些函数是纯粹的平台无关逻辑，由浏览器端
 * 的通知运行时（src/client/watcher.ts）在每次触发时调用；实际投递由打包期
 * 选定的后端（浏览器原生 Notification 或 @tauri-apps/plugin-notification）
 * 完成。
 */

/** `turn/end` 原因类型对应的结果文案；未知类型回退为通用的结束文案。 */
export function resultText(kind: string): string {
  switch (kind) {
    case 'completed': return '任务已完成'
    case 'error': return '任务失败'
    case 'aborted': return '任务已中止'
    case 'max-tokens': return '任务达到 token 上限'
    case 'blocked': return '任务被阻塞'
    case 'interrupted': return '任务被中断'
    default: return '任务结束'
  }
}

/** 带进通知正文的文本片段（提问或标题）的最大长度。 */
const BODY_TEXT_MAX = 80

/** 将文本截断到 `max` 个码位，超出时追加省略号。 */
function truncateText(text: string, max: number): string {
  const chars = [...text]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text
}

/**
 * 归一化一个待进通知正文的会话标题：去空白并截断到
 * {@link BODY_TEXT_MAX} 个码位；空白或非字符串输入归一为空字符串
 * （正文据此省略标题部分）。
 * @param title - 原始标题（通常是会话列表行的 `title`）。
 * @returns 可入正文的标题，或 ''。
 */
export function clipTitle(title: unknown): string {
  if (typeof title !== 'string' || title.trim() === '') return ''
  return truncateText(title.trim(), BODY_TEXT_MAX)
}

/**
 * 通知正文：结果文案，可选地加上「任务：<会话标题>」。空标题会被省略；
 * 会话 id 不进正文（诊断用，由 watcher 打进日志）。
 * @param result - 结果文案。
 * @param title - 会话标题，尚不存在时为 ''。
 * @returns 最终的通知正文。
 */
export function buildBody(result: string, title = ''): string {
  return title === '' ? result : `${result} - 任务：${title}`
}

/**
 * 从 `ask_user_question` 工具调用的原始 `arguments` JSON 字符串中提取
 * 第一个问题的文本，经过去空白和截断以放入通知正文。JSON 无法解析或
 * 文本缺失时返回空字符串。
 * @param argumentsString - `tool/call` 事件中的原始 `arguments` 字符串。
 * @returns 第一个问题去空白后的文本，截断到 {@link BODY_TEXT_MAX} 个字符。
 */
export function blockedQuestionText(argumentsString: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsString)
  } catch {
    return ''
  }
  const questions = (parsed as { questions?: unknown } | undefined)?.questions
  if (!Array.isArray(questions) || questions.length === 0) return ''
  const question = (questions[0] as { question?: unknown } | undefined)?.question
  if (typeof question !== 'string' || question.trim() === '') return ''
  return truncateText(question.trim(), BODY_TEXT_MAX)
}

/**
 * 构建阻塞动作的通知正文：类型标签加上提取出的详情。详情为空或类型未知
 * 时回退为通用的「需要处理」文案；空标题会被省略。
 * @param kind - `'question'` 或 `'approval'`。
 * @param detail - 提取出的问题文本，或 `toolName — reason`。
 * @param sessionId - 根会话 id（保留用于日志定位，不进正文）。
 * @param title - 会话标题，尚不存在时为 ''。
 * @returns 最终的通知正文。
 */
export function blockedBody(kind: string, detail: string, sessionId: string, title = ''): string {
  const label = kind === 'question' ? '需要回答' : kind === 'approval' ? '需要批准' : '需要处理'
  const base = detail === '' || label === '需要处理' ? '需要处理' : `${label}：${detail}`
  return title === '' ? base : `${base} — ${title}`
}

/**
 * 由 `approval/asked` 事件的工具名和可选原因组合审批详情：仅工具名、
 * `toolName — reason`，或工具名缺失时为 `''`——空字符串让
 * {@link blockedBody} 回退到通用文案。
 * @param toolName - 被请求的工具名（已窄化为字符串或 ''）。
 * @param reason - 可选的人类可读原因（字符串或 ''）。
 * @returns 组合后的详情。
 */
export function approvalDetail(toolName: string, reason: string): string {
  if (toolName === '') return ''
  return reason === '' ? toolName : `${toolName} — ${reason}`
}
