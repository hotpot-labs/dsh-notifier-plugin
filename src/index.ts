/**
 * DeepSeek Harness 的桌面通知插件：在运行结束、模型提问和审批请求时推送
 * 系统通知。
 *
 * 通知的实际投递已移至浏览器侧（`./client`）：客户端订阅宿主的 mux/host
 * 事件流，驱动通知状态机，并通过打包期选定的后端发出通知——浏览器原生
 * `Notification()`（web 构建）或 `@tauri-apps/plugin-notification`
 * （Tauri 桌面壳构建，详见 tsdown.config.ts 的
 * `DSH_NOTIFIER_BACKEND`）。宿主侧只保留配置 schema 与
 * `dsh-notifier` 设置命名空间，供网页设置卡片与客户端通知运行时
 * 汇合。
 * @module dsh-notifier-plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

export const name = 'dsh-notifier-plugin'

/** 连接宿主侧与网页设置卡片/通知运行时的设置命名空间。 */
export const NOTIFICATION_NS = settingsNamespace('dsh-notifier')

/** 插件配置；所有字段均可选，缺省时回退到 schema 默认值。 */
export interface Config {
  /** 总开关；为 false 时静音所有通知。 */
  enabled?: boolean
  /** 通知标题。 */
  title?: string
  /** 发送通知时允许系统提示音（具体声音由平台决定）。 */
  sound?: boolean
  /** 阻塞类通知（提问 + 审批）的总开关。 */
  onBlocked?: boolean
  /** 提问（`ask_user_question`）通知；仅在 onBlocked 开启时生效。 */
  onQuestion?: boolean
  /** 审批/权限通知；仅在 onBlocked 开启时生效。 */
  onApproval?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  title: z.string().default('DeepSeek Harness'),
  sound: z.boolean().default(true),
  onBlocked: z.boolean().default(true),
  onQuestion: z.boolean().default(true),
  onApproval: z.boolean().default(true),
})

/**
 * 安装 `dsh-notifier` 设置命名空间。配置由浏览器端的通知运行时实时
 * 解析：网页设置卡片的用户层优先于入口配置，入口配置又优先于默认值，
 * 因此在「设置」中的开关无需重启即可生效。
 * @param ctx - 插件上下文。
 * @param config - 组合入口配置（cordis.patch.yml 层）。
 */
export function apply(ctx: Context, config: Config = {}): void {
  installSettingsSection(ctx, NOTIFICATION_NS, Config, config, {
    setSource: () => {},
    onChange: () => {},
  })
}
