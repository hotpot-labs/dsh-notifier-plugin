/**
 * dsh 通知插件的浏览器侧：`dsh-notifier` 命名空间的设置卡片，渲染在
 * 「设置 → 插件 → 插件配置」之下。卡片以其命名空间键注册进
 * `settings.plugin.item` 按键槽位；该标签页为宿主提供的每个命名空间派发
 * 一个键，从而自动把本卡片与宿主侧配对。
 *
 * 除了设置卡片，本入口还启动通知运行时（watcher.ts）：订阅宿主的
 * mux/host 事件流，在运行结束、模型提问和审批请求时通过打包期选定的
 * 后端（浏览器原生 Notification 或 @tauri-apps/plugin-notification，
 * 见 backend.ts）投递系统通知。
 *
 * 本卡片依赖的 dsh 客户端运行时包（`dsh-client-runtime`、
 * `dsh-client-ui-settings-plugins`）既不是 externals 也未发布，因此这里
 * 用到的每个服务接口都是在本地声明的最小结构化类型——跨插件协作只能
 * 经由 cordis 服务，绝不做值导入（客户端 bundle 纯净性门禁）。运行时
 * 导入只允许出现 `react`、`@deepseek-ai/cordis` 和冻结模块表。
 * @module dsh-notifier-plugin/client
 */
import type { Context } from '@deepseek-ai/cordis'
import { NotificationCard } from './NotificationCard'
import type {
  BoolField, BoolFieldState, FieldName, NotificationCardState, TitleFieldState,
} from './NotificationCard'
import { backend } from './backend'
import { en, zh } from './locale'
import { NotificationWatcher, resolveConfig } from './watcher'
import type { EventsFace, SessionsFace } from './watcher'

/** 把本卡片与宿主侧连接起来的设置命名空间（与 src/index.ts 一致）。 */
export const NOTIFICATION_NS = 'dsh-notifier'

/** 本卡片文案的字典命名空间（插槽注册项的 `locale:`）。 */
export const LOCALE_NS = 'settings.dshNotifier'

/** 一个命名空间的设置作用域快照的最小结构化类型。 */
export type SettingsScopeSnapshot = {
  /** 宿主的 section 解析完成后为 'ready'；否则为 'loading' / 'unavailable'。 */
  status: string
  /** 解析后的 section 值（schema 默认值 + 组合层 + 用户层）。 */
  value: Record<string, unknown> | undefined
  /** 组合层（用户文档之下的所有内容）。 */
  base: Record<string, unknown> | undefined
  /** 原始用户层；标记字段被覆盖的是键的*存在性*，而不是它的值。 */
  user: Record<string, unknown> | undefined
  /** 约束下一次写入的文档修订号。 */
  revision: number | undefined
  /** 宿主文档是否接受写入。 */
  writable: boolean
}

/** 已绑定的按命名空间设置作用域的最小结构化类型。 */
export type SettingsScope = {
  /** 当前的同步快照（在下一次变化前保持引用稳定）。 */
  getSnapshot(): SettingsScopeSnapshot
  /** 观察快照更替；返回取消订阅函数。 */
  subscribe(listener: () => void): () => void
  /** 排队一次受修订号约束的字段写入。 */
  set(field: string, value: unknown): Promise<void>
  /** 排队一次字段清除，回到组合层的值。 */
  unset(field: string): Promise<void>
}

/** 本插件用到的插槽服务成员的最小结构化类型。 */
export type SlotsFace = {
  /** 在具名插槽被声明后运行回调；每次声明生命周期内重新运行。 */
  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
  /** 向已声明的插槽贡献一个组件；返回注册的销毁函数。 */
  register(options: {
    name: string
    key?: string
    locale?: string
    inject?: () => Record<string, unknown>
  }, component: unknown): () => void
}

/** 本插件用到的语言服务成员的最小结构化类型。 */
export type LocaleFace = {
  /** 一次调用注册一个命名空间的全部语言字典；返回销毁函数。 */
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
}

/** 设置作用域绑定服务的最小结构化类型。 */
export type SettingsScopeBinderFace = {
  /** 在调用方插件的生命周期上绑定一个命名空间作用域。 */
  bind(spec: { namespace: string }): SettingsScope
}

/** 浏览器插件上下文：cordis 上下文加上 {@link inject} 中列出的服务。 */
export type ClientContext = Context & {
  slots: SlotsFace
  locale: LocaleFace
  settingsScope: SettingsScopeBinderFace
  /** 连接服务：通知运行时经其 `api.events` 并开自己的 mux/host 流。 */
  connection: { api: { events: EventsFace } }
  /** 会话服务：通知运行时读取列表快照以排除子代理、解析标题。 */
  sessions: SessionsFace
}

/** 裸快照 store（插槽机制会把它绑定为 `use*` 选择器 hook 的形态）。 */
export type SnapshotStore<T> = {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  /** 替换快照并通知订阅者。 */
  set(next: T): void
}

function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** 保存卡片时，单个字段的暂存草稿要执行的写入。 */
type FieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' }

/** 单个字段在存储值与草稿文本之间的转换方式。 */
type FieldSpec = {
  /** 把存储值渲染为草稿文本；section 中没有该值时为空字符串。 */
  format: (value: unknown) => string
  /** 该草稿暂存的写入；文本不是可接受的值时为 undefined。 */
  parse: (text: string) => FieldWrite | undefined
}

/** 布尔字段；开关暂存 'true' / 'false' 草稿文本。 */
function boolField(): FieldSpec {
  return {
    format: value => typeof value === 'boolean' ? String(value) : '',
    parse: (text) => {
      if (text === 'true') return { kind: 'set', value: true }
      if (text === 'false') return { kind: 'set', value: false }
      if (text === '') return { kind: 'clear' }
      return undefined
    },
  }
}

/** 自由文本字段；空草稿清除该字段。 */
function textField(): FieldSpec {
  return {
    format: value => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    },
  }
}

/** schema 默认值，复制自宿主侧的 Config（默认值也会随 section 值到达）。 */
const DEFAULTS: Record<FieldName, unknown> = {
  enabled: true,
  sound: true,
  onBlocked: true,
  onQuestion: true,
  onApproval: true,
  title: 'DeepSeek Harness',
}

/** 单个字段的暂存编辑：草稿文本加上该编辑是否清除字段。 */
type StagedEdit = { text: string; clear: boolean }

/**
 * 在 `dsh-notifier` 命名空间上暂存卡片的编辑，并在保存时写入——
 * 与内置卡片的 CardForm 是同一模型，在此重建是因为该模型无法跨越
 * bundle 纯净性门禁。宿主是一个值是否被接受的唯一权威，因此每次写入后
 * 都从用户层读回结果，而不是在本地预测。
 */
export class NotificationCardController {
  private readonly specs: Record<FieldName, FieldSpec> = {
    enabled: boolField(),
    sound: boolField(),
    onBlocked: boolField(),
    onQuestion: boolField(),
    onApproval: boolField(),
    title: textField(),
  }
  private readonly staged = new Map<FieldName, StagedEdit>()
  private saving = false
  private failed = false
  private readonly store: SnapshotStore<NotificationCardState>

  /**
   * @param scope - `dsh-notifier` 命名空间已绑定的设置作用域。
   */
  constructor(private readonly scope: SettingsScope) {
    this.store = createSnapshotStore(this.projection())
    scope.subscribe(() => { this.publish() })
  }

  /**
   * 构建卡片的插槽注册项注入的接口：由渲染器绑定为 `useCard` 选择器
   * hook 的 `hooks.card` store，加上原样透传的表单动作。
   * @returns 卡片的注入接口。
   */
  inject(): Record<string, unknown> {
    return {
      hooks: { card: this.store },
      toggle: (field: BoolField) => { this.toggle(field) },
      editTitle: (text: string) => { this.editTitle(text) },
      resetField: (field: FieldName) => { this.resetField(field) },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  /** 暂存一个布尔字段的取反。 */
  private toggle(field: BoolField): void {
    this.stage(field, { text: String(!this.boolValue(field)), clear: false })
  }

  /** 为标题字段暂存草稿文本。 */
  private editTitle(text: string): void {
    this.stage('title', { text, clear: false })
  }

  /** 暂存一次清除，期间显示组合层的值。 */
  private resetField(field: FieldName): void {
    this.stage(field, { text: this.specs[field].format(this.baseValue(field)), clear: true })
  }

  /** 丢弃所有暂存的编辑。 */
  private discard(): void {
    if (this.staged.size === 0 && !this.failed) return
    this.staged.clear()
    this.failed = false
    this.publish()
  }

  /**
   * 写入所有暂存的编辑，然后按宿主实际接受的内容重新播种。未能落地的
   * 保存会保留草稿，供用户修正。
   */
  private async save(): Promise<void> {
    const plan = this.plan()
    if (plan.length === 0 || this.saving) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    for (const write of plan) {
      landed = await write() && landed
    }
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  /** 一次保存会写入的所有暂存编辑，按字段暂存的顺序排列。 */
  private plan(): Array<() => Promise<boolean>> {
    const plan: Array<() => Promise<boolean>> = []
    for (const [field, staged] of this.staged) {
      const spec = this.specs[field]
      if (staged.clear) {
        if (this.stored(field)) plan.push(() => this.clear(field))
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) continue
      plan.push(write.kind === 'clear' ? () => this.clear(field) : () => this.storeValue(field, write.value))
    }
    return plan
  }

  private async clear(field: FieldName): Promise<boolean> {
    await this.scope.unset(field)
    return !this.stored(field)
  }

  private async storeValue(field: FieldName, value: unknown): Promise<boolean> {
    await this.scope.set(field, value)
    return this.userLayer()?.[field] === value
  }

  private stage(field: FieldName, edit: StagedEdit): void {
    this.staged.set(field, edit)
    this.failed = false
    this.publish()
  }

  private publish(): void {
    this.store.set(this.projection())
  }

  private projection(): NotificationCardState {
    const snapshot = this.scope.getSnapshot()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.plan().length > 0,
      saving: this.saving,
      failed: this.failed,
      enabled: this.boolState('enabled'),
      sound: this.boolState('sound'),
      onBlocked: this.boolState('onBlocked'),
      onQuestion: this.boolState('onQuestion'),
      onApproval: this.boolState('onApproval'),
      title: this.titleState(),
    }
  }

  private boolState(field: BoolField): BoolFieldState {
    return { value: this.boolValue(field), overridden: this.overridden(field) }
  }

  private titleState(): TitleFieldState {
    const staged = this.staged.get('title')
    return {
      text: staged?.text ?? this.specs.title.format(this.sectionValue('title')),
      overridden: this.overridden('title'),
    }
  }

  /** 布尔控件渲染的值：暂存的草稿，否则 section 值，否则默认值。 */
  private boolValue(field: BoolField): boolean {
    const text = this.staged.get(field)?.text ?? this.specs[field].format(this.sectionValue(field))
    if (text === 'true') return true
    if (text === 'false') return false
    return DEFAULTS[field] as boolean
  }

  /** 保存后是否会在用户层留下该字段的条目。 */
  private overridden(field: FieldName): boolean {
    const staged = this.staged.get(field)
    if (staged === undefined) return this.stored(field)
    if (staged.clear) return false
    return this.specs[field].parse(staged.text)?.kind === 'set'
  }

  private snapshot(): SettingsScopeSnapshot {
    return this.scope.getSnapshot()
  }

  private sectionValue(field: FieldName): unknown {
    return this.snapshot().value?.[field]
  }

  private baseValue(field: FieldName): unknown {
    return this.snapshot().base?.[field]
  }

  private userLayer(): Record<string, unknown> | undefined {
    return this.snapshot().user
  }

  /** 用户层是否携带该字段（以存在性判断，而非值相等）。 */
  private stored(field: FieldName): boolean {
    const user = this.userLayer()
    return user !== undefined && Object.hasOwn(user, field)
  }
}

/**
 * 卡片的样式表。复刻 `ui-settings-plugins` 的 `PluginCard.module.css` /
 * `fields.module.css`，基于 `--dsw-alias-*` 令牌，类名加
 * `dsh-notifier-` 前缀（普通类名：本包没有 CSS Modules 流水线）。
 * 由 {@link apply} 以一个 `<style>` 元素注入。
 */
const STYLES = `
.dsh-notifier-card {
  list-style: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3);
  transition: border-color .16s, background .16s;
}
.dsh-notifier-card:hover {
  border-color: var(--dsw-alias-label-dimmed);
}
.dsh-notifier-card--open {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-label-dimmed);
}
.dsh-notifier-card__header {
  width: 100%;
  appearance: none;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 12px;
}
.dsh-notifier-card__header:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.dsh-notifier-card__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dsh-notifier-card__name {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary);
}
.dsh-notifier-card__description {
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-notifier-card__chevron {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  transition: transform .16s;
}
.dsh-notifier-card__chevron--open {
  transform: rotate(180deg);
}
.dsh-notifier-card__pending {
  flex: none;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  font-weight: 500;
  white-space: nowrap;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.dsh-notifier-card__body {
  border-top: 1px solid var(--dsw-alias-border-l2);
  margin: 0 16px;
  padding-bottom: 8px;
}
.dsh-notifier-card__read-only {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-notifier-card__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 0 4px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dsh-notifier-card__failed {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-error);
}
.dsh-notifier-card__discard,
.dsh-notifier-card__test,
.dsh-notifier-card__save {
  appearance: none;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 5px 14px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
}
.dsh-notifier-card__discard,
.dsh-notifier-card__test {
  border-color: var(--dsw-alias-border-l2);
  background: none;
  color: var(--dsw-alias-label-secondary);
}
.dsh-notifier-card__test {
  margin-right: auto;
}
.dsh-notifier-card__discard:hover:not(:disabled),
.dsh-notifier-card__test:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed);
}
.dsh-notifier-card__save {
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
}
.dsh-notifier-card__discard:disabled,
.dsh-notifier-card__save:disabled {
  opacity: 0.4;
  cursor: default;
}
.dsh-notifier-card__discard:focus-visible,
.dsh-notifier-card__test:focus-visible,
.dsh-notifier-card__save:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dsh-notifier-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}
.dsh-notifier-field + .dsh-notifier-field {
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dsh-notifier-field__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dsh-notifier-field__label {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-notifier-field__badges {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.dsh-notifier-field__badge {
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
  font-weight: 500;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.dsh-notifier-field__reset {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsh-notifier-field__reset:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
}
.dsh-notifier-field__reset:disabled {
  cursor: default;
}
.dsh-notifier-field__input {
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-notifier-field__input:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-notifier-field__input:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
.dsh-notifier-field__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-notifier-switch {
  appearance: none;
  flex: none;
  margin: 0;
  width: 36px;
  height: 20px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  position: relative;
  cursor: pointer;
  transition: background .16s, border-color .16s;
}
.dsh-notifier-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary);
  transition: transform .16s, background .16s;
}
.dsh-notifier-switch:checked {
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-notifier-switch:checked::after {
  transform: translateX(16px);
  background: #fff;
}
.dsh-notifier-switch:disabled {
  opacity: 0.4;
  cursor: default;
}
.dsh-notifier-switch:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
`

/** 注入卡片的样式表；销毁函数在插件卸载时移除它。 */
function installStyles(): () => void {
  // 非浏览器运行（以 node 启动客户端树）没有 document。
  if (typeof document === 'undefined') return () => {}
  const style = document.createElement('style')
  style.setAttribute('data-dsh-notifier-plugin', '')
  style.textContent = STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}

/** 必需的服务（cordis fiber 注入；与设置卡片的做法一致）。 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope', 'sessions']

/**
 * 客户端插件主体：注册语言字典，绑定 `dsh-notifier` 设置作用域，
 * 在命名空间键下把卡片贡献进 `settings.plugin.item`，并启动通知运行时
 * （订阅宿主 mux/host 流，按实时配置投递系统通知）。
 * `ctx.slots.inject` 会把贡献推迟到「插件」区的配置标签页声明该插槽之后。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-notifier-plugin: dictionaries')
  ctx.effect(installStyles, 'dsh-notifier-plugin: styles')
  const scope = ctx.settingsScope.bind({ namespace: NOTIFICATION_NS })
  const card = new NotificationCardController(scope)
  /** 发送一条测试通知（用户手势触发，同时完成通知权限请求）。 */
  const testNotification = (body: string): void => {
    const config = resolveConfig(scope.getSnapshot())
    void backend.notify({ title: config.title, body, silent: !config.sound })
  }
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: NOTIFICATION_NS,
    locale: LOCALE_NS,
    inject: () => ({ ...card.inject(), testNotification }),
  }, NotificationCard))
  const watcher = new NotificationWatcher({
    scope,
    sessions: ctx.sessions,
    events: ctx.connection.api.events,
    backend,
    // 关键状态转换进 debug 级日志，排查「没收到通知」时可在控制台打开。
    log: message => { console.debug('[dsh-notifier-plugin]', message) },
  })
  ctx.effect(() => watcher.start(), 'dsh-notifier-plugin: watcher')
}
