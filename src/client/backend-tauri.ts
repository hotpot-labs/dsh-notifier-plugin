/**
 * Tauri 桌面壳后端：`@tauri-apps/plugin-notification`。Tauri 的 WKWebView
 * 不支持浏览器 Notification API，桌面壳必须走原生插件桥。
 *
 * 注意：宿主 Tauri 应用必须在 Rust 侧安装 `tauri-plugin-notification` 并在
 * capabilities 中授予 `notification:default`，否则权限请求会一直失败——
 * 失败时这里只告警一次并跳过。
 */
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import type { NotificationBackend } from './backend'

let warned = false

/** 每次会话只告警一次，避免事件风暴刷控制台。 */
function warnOnce(message: string, error?: unknown): void {
  if (warned) return
  warned = true
  console.warn(`[dsh-notifier-plugin] ${message}`, error ?? '')
}

/** Tauri plugin-notification 后端实例（经 `#notifier-backend` 别名导出）。 */
export const backend: NotificationBackend = {
  async ensurePermission(): Promise<boolean> {
    try {
      if (await isPermissionGranted()) return true
      return await requestPermission() === 'granted'
    } catch (error) {
      warnOnce('Tauri 通知插件不可用（宿主应用是否安装了 tauri-plugin-notification 并授权？）。', error)
      return false
    }
  },

  async notify({ title, body }): Promise<boolean> {
    if (!await this.ensurePermission()) return false
    try {
      sendNotification({ title, body })
      return true
    } catch (error) {
      console.warn('[dsh-notifier-plugin] 通知投递失败：', error)
      return false
    }
  },

  async isAppInForeground(): Promise<boolean> {
    try {
      return await getCurrentWindow().isFocused()
    } catch {
      // 查询失败（如不在 Tauri 环境）：按不在前台处理，不丢通知。
      return false
    }
  },
}
