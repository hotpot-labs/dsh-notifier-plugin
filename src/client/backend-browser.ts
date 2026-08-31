/**
 * 浏览器原生 `Notification()` 后端。用于标准 web 构建：页面以 http(s)
 * 提供时 Notification API 可用；权限只能在用户上下文中请求，被拒后只能
 * 由用户在浏览器设置里改回——两种失败都只告警一次。
 */
import type { NotificationBackend } from './backend'

let warned = false

/** 每次构建只告警一次，避免事件风暴刷控制台。 */
function warnOnce(message: string): void {
  if (warned) return
  warned = true
  console.warn(`[dsh-notifier-plugin] ${message}`)
}

/** 浏览器原生 Notification 后端实例（经 `#notifier-backend` 别名导出）。 */
export const backend: NotificationBackend = {
  async ensurePermission(): Promise<boolean> {
    if (typeof Notification === 'undefined') return false
    if (Notification.permission === 'granted') return true
    if (Notification.permission === 'denied') return false
    try {
      return await Notification.requestPermission() === 'granted'
    } catch {
      return false
    }
  },

  async notify({ title, body, silent }): Promise<boolean> {
    if (typeof Notification === 'undefined') {
      warnOnce('当前环境没有 Notification API，通知被跳过。')
      return false
    }
    if (!await this.ensurePermission()) {
      warnOnce('通知权限未授予，通知被跳过。可在设置卡片点击「发送测试通知」授权。')
      return false
    }
    try {
      new Notification(title, { body, silent })
      return true
    } catch (error) {
      console.warn('[dsh-notifier-plugin] 通知投递失败：', error)
      return false
    }
  },

  async isAppInForeground(): Promise<boolean> {
    if (typeof document === 'undefined') return false
    return document.visibilityState === 'visible' && document.hasFocus()
  },
}
