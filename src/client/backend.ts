/**
 * 通知投递后端的统一接口与打包期选择。
 *
 * 两个实现：浏览器原生 `Notification()`（backend-browser.ts）与 Tauri 的
 * `@tauri-apps/plugin-notification`（backend-tauri.ts，用于 Tauri 桌面壳——
 * 其 WKWebView 不支持浏览器 Notification API）。打包插件时通过环境变量
 * `DSH_NOTIFIER_BACKEND=browser|tauri` 选择：tsdown.config.ts 把
 * `#notifier-backend` 别名指向选中的实现文件，未选中的实现根本不会
 * 进入模块图（也就不会把 @tauri-apps/* 打进 web 产物）。
 */

/** 一条待投递的通知。 */
export interface NotificationRequest {
  /** 通知标题（配置项 `title` 的解析值）。 */
  title: string
  /** 通知正文。 */
  body: string
  /** true 时请求静默投递（配置项 `sound` 取反）；是否真静音由平台决定。 */
  silent: boolean
}

/** 通知投递后端。所有失败都在内部吞掉——通知绝不能破坏它所汇报的运行。 */
export interface NotificationBackend {
  /**
   * 确保通知权限已授予。浏览器端在权限为 default 时发起请求（部分浏览器
   * 要求用户手势，设置卡片的「发送测试通知」按钮为此而设）。
   * @returns 是否可以投递通知。
   */
  ensurePermission(): Promise<boolean>
  /**
   * 投递一条通知；权限缺失或平台拒绝时在内部告警并跳过。
   * @returns 是否真正构造/发送了通知（false = 被跳过，便于诊断日志区分
   * 「已投递」与「被权限拦截」）。
   */
  notify(request: NotificationRequest): Promise<boolean>
  /**
   * 用户此刻是否正看着本应用的 UI（web：dsh tab 可见且窗口聚焦；桌面：
   * 应用主窗口聚焦）。前台时系统通知是冗余的，watcher 据此跳过投递；
   * 查询失败时实现方返回 false——宁可多通知，也不丢通知。
   */
  isAppInForeground(): Promise<boolean>
}

// 打包期别名（tsdown.config.ts 的 alias）：指向选中的后端实现。
import { backend } from '#notifier-backend'

/** 本产物使用的通知后端。 */
export { backend }
