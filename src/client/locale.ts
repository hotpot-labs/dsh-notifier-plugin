/**
 * 通知设置卡片的语言字典。注册在 `settings.dshNotifier` 命名空间
 * 之下；插槽机制据此为卡片合成 `t` 席位。
 */

/** 通知卡片渲染所用的语言键。 */
export type NotificationLocaleKey =
  | 'name' | 'description'
  | 'expand' | 'collapse' | 'readOnly' | 'unsaved'
  | 'save' | 'saving' | 'discard' | 'saveFailed'
  | 'test' | 'testBody'
  | 'overridden' | 'reset'
  | 'enabled' | 'enabledHint'
  | 'sound' | 'soundHint'
  | 'onBlocked' | 'onBlockedHint'
  | 'onQuestion' | 'onQuestionHint'
  | 'onApproval' | 'onApprovalHint'
  | 'titleField' | 'titleFieldHint'

/** 英文文案。 */
export const en: Record<NotificationLocaleKey, string> = {
  name: 'Notifications',
  description: 'Native desktop notifications for run completion, model questions, and approval requests.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  readOnly: 'This deployment stores settings read-only.',
  unsaved: 'Unsaved',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  test: 'Send test notification',
  testBody: 'This is a test notification from DeepSeek Harness.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  enabled: 'Enable notifications',
  enabledHint: 'Master switch — turning it off silences every notification.',
  sound: 'Play a sound',
  soundHint: 'Play the system notification sound alongside each notification.',
  onBlocked: 'While waiting on you',
  onBlockedHint: 'Master switch for the notifications fired while the agent is blocked waiting for your input.',
  onQuestion: 'Model questions',
  onQuestionHint: 'Notify when the model asks you a question.',
  onApproval: 'Approval requests',
  onApprovalHint: 'Notify when a tool call needs your approval.',
  titleField: 'Notification title',
  titleFieldHint: 'Shown as the title of every notification. Leave blank to use the default.',
}

/** 简体中文文案。 */
export const zh: Record<NotificationLocaleKey, string> = {
  name: '桌面通知',
  description: '运行结束、模型提问和审批请求时，发送 macOS / Linux / Windows 原生系统通知。',
  expand: '展开设置',
  collapse: '收起设置',
  readOnly: '本部署的设置为只读。',
  unsaved: '未保存',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  test: '发送测试通知',
  testBody: '这是一条来自 DeepSeek Harness 的测试通知。',
  overridden: '已覆盖',
  reset: '恢复默认',
  enabled: '启用通知',
  enabledHint: '总开关——关闭后不再发送任何通知。',
  sound: '播放提示音',
  soundHint: '发送通知时同时播放系统提示音。',
  onBlocked: '等待你操作时',
  onBlockedHint: '阻塞类通知（提问与审批）的总开关；关闭后这两类都不再提醒。',
  onQuestion: '模型提问',
  onQuestionHint: '模型向你提问时发送通知。',
  onApproval: '审批请求',
  onApprovalHint: '工具调用需要你的批准时发送通知。',
  titleField: '通知标题',
  titleFieldHint: '每条系统通知的标题；留空则使用默认值。',
}
