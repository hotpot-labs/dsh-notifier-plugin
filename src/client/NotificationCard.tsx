/**
 * 通知插件的设置卡片。结构与样式复刻 `ui-settings-plugins` 内置的
 * PluginCard（该包无法跨越客户端 bundle 纯净性门禁被值导入），此处用
 * `dsh-notifier-` 前缀的普通类名重新实现；样式表由入口（`index.ts`）
 * 注入，而非经由 CSS Modules。
 *
 * 卡片在本地暂存编辑，仅在点击「保存」时写入，复刻内置卡片的交互模型：
 * 卡片头部会标记存在未保存编辑的卡片，键出现在用户层中的字段会带上
 * 「已覆盖」徽标（以键的存在性判断，而非值的相等性）。
 */

import React, { useState } from 'react'

/** 卡片编辑的布尔字段（`dsh-notifier` 命名空间的设置键）。 */
export type BoolField = 'enabled' | 'sound' | 'onBlocked' | 'onQuestion' | 'onApproval'

/** 卡片编辑的全部字段。 */
export type FieldName = BoolField | 'title'

/** 开关所渲染的单个布尔字段。 */
export type BoolFieldState = {
  /** 保存后会留下的生效值（编辑期间为暂存值）。 */
  value: boolean
  /** 保存后是否会在用户层留下该字段的条目。 */
  overridden: boolean
}

/** 文本输入框所渲染的标题字段。 */
export type TitleFieldState = {
  /** 输入框渲染的草稿文本。 */
  text: string
  /** 保存后是否会在用户层留下该字段的条目。 */
  overridden: boolean
}

/** 卡片的完整快照，由控制器的 store 发布。 */
export type NotificationCardState = {
  /** 命名空间未提供给本客户端时为 false，此时卡片不渲染任何内容。 */
  available: boolean
  /** 宿主文档是否接受写入。 */
  writable: boolean
  /** 表单是否持有保存时会写入的编辑。 */
  dirty: boolean
  /** 是否有一次保存正在进行。 */
  saving: boolean
  /** 上一次保存是否未按暂存内容落地；在下一次编辑或保存时清除。 */
  failed: boolean
  enabled: BoolFieldState
  sound: BoolFieldState
  onBlocked: BoolFieldState
  onQuestion: BoolFieldState
  onApproval: BoolFieldState
  title: TitleFieldState
}

/**
 * 渲染器为卡片绑定的 props：框架合成的 `t` 席位（注册项声明了
 * `locale:`）、从注入的 `hooks.card` store 绑定的 `useCard` 选择器
 * hook，以及从注入接口原样透传的表单动作。
 */
export type NotificationCardProps = {
  /** 翻译 `settings.dshNotifier` 命名空间的字典键。 */
  t: (key: string) => string
  /** 卡片快照上的选择器 hook（由插槽机制以 uSES 绑定）。 */
  useCard: <S>(selector: (state: NotificationCardState) => S) => S
  /** 暂存一个布尔字段的取反。 */
  toggle: (field: BoolField) => void
  /** 为标题字段暂存草稿文本。 */
  editTitle: (text: string) => void
  /** 暂存一次清除，使保存后该字段重新继承组合层的值。 */
  resetField: (field: FieldName) => void
  /** 写入所有暂存的编辑。 */
  save: () => void
  /** 丢弃所有暂存的编辑。 */
  discard: () => void
  /** 发送一条测试通知（用户手势触发，同时完成通知权限请求）。 */
  testNotification: (body: string) => void
}

/** 展开/收起的箭头图标；内联实现，因为基础组件的图标集无法在此被值导入。 */
function Chevron(props: { open: boolean }) {
  return (
    <svg
      className={'dsh-notifier-card__chevron' + (props.open ? ' dsh-notifier-card__chevron--open' : '')}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path d="M3.5 5.25L7 8.75L10.5 5.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 「已覆盖」徽标加上重置控件，重置会暂存一次清除以回到组合层的值。 */
function OverrideBadges(props: {
  disabled: boolean
  overriddenLabel: string
  resetLabel: string
  onReset: () => void
}) {
  return (
    <span className="dsh-notifier-field__badges">
      <span className="dsh-notifier-field__badge">{props.overriddenLabel}</span>
      <button
        type="button"
        className="dsh-notifier-field__reset"
        disabled={props.disabled}
        onClick={props.onReset}
      >
        {props.resetLabel}
      </button>
    </span>
  )
}

/** 单个布尔字段：标签、「已覆盖」徽标，以及基于原生 checkbox 的开关。 */
function ToggleRow(props: {
  id: string
  label: string
  hint: string
  state: BoolFieldState
  disabled: boolean
  overriddenLabel: string
  resetLabel: string
  onToggle: () => void
  onReset: () => void
}) {
  return (
    <div className="dsh-notifier-field">
      <div className="dsh-notifier-field__head">
        <label className="dsh-notifier-field__label" htmlFor={props.id}>{props.label}</label>
        {props.state.overridden
          ? (
            <OverrideBadges
              disabled={props.disabled}
              overriddenLabel={props.overriddenLabel}
              resetLabel={props.resetLabel}
              onReset={props.onReset}
            />
          )
          : null}
        <input
          id={props.id}
          type="checkbox"
          className="dsh-notifier-switch"
          checked={props.state.value}
          disabled={props.disabled}
          onChange={props.onToggle}
        />
      </div>
      <p className="dsh-notifier-field__hint">{props.hint}</p>
    </div>
  )
}

/**
 * 渲染通知设置卡片。
 * @param props - 语言文案、卡片快照选择器及其表单动作。
 * @returns 卡片；命名空间不可用时不渲染任何内容。
 */
export function NotificationCard(props: NotificationCardProps) {
  const [open, setOpen] = useState(false)
  const { t } = props
  const state = props.useCard(snapshot => snapshot)
  if (!state.available) return null
  const disabled = !state.writable
  const toggles: { field: BoolField; labelKey: string; hintKey: string }[] = [
    { field: 'enabled', labelKey: 'enabled', hintKey: 'enabledHint' },
    { field: 'sound', labelKey: 'sound', hintKey: 'soundHint' },
    { field: 'onBlocked', labelKey: 'onBlocked', hintKey: 'onBlockedHint' },
    { field: 'onQuestion', labelKey: 'onQuestion', hintKey: 'onQuestionHint' },
    { field: 'onApproval', labelKey: 'onApproval', hintKey: 'onApprovalHint' },
  ]
  return (
    <li className={'dsh-notifier-card' + (open ? ' dsh-notifier-card--open' : '')}>
      <button
        type="button"
        className="dsh-notifier-card__header"
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('name')}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className="dsh-notifier-card__head-text">
          <span className="dsh-notifier-card__name">{t('name')}</span>
          <span className="dsh-notifier-card__description">{t('description')}</span>
        </span>
        {state.dirty ? <span className="dsh-notifier-card__pending">{t('unsaved')}</span> : null}
        <Chevron open={open} />
      </button>
      {open
        ? (
          <div className="dsh-notifier-card__body">
            {!state.writable ? <p className="dsh-notifier-card__read-only" role="status">{t('readOnly')}</p> : null}
            {toggles.map(({ field, labelKey, hintKey }) => (
              <ToggleRow
                key={field}
                id={`dsh-notifier-${field}`}
                label={t(labelKey)}
                hint={t(hintKey)}
                state={state[field]}
                disabled={disabled}
                overriddenLabel={t('overridden')}
                resetLabel={t('reset')}
                onToggle={() => { props.toggle(field) }}
                onReset={() => { props.resetField(field) }}
              />
            ))}
            <div className="dsh-notifier-field">
              <div className="dsh-notifier-field__head">
                <label className="dsh-notifier-field__label" htmlFor="dsh-notifier-title">{t('titleField')}</label>
                {state.title.overridden
                  ? (
                    <OverrideBadges
                      disabled={disabled}
                      overriddenLabel={t('overridden')}
                      resetLabel={t('reset')}
                      onReset={() => { props.resetField('title') }}
                    />
                  )
                  : null}
              </div>
              <input
                id="dsh-notifier-title"
                type="text"
                className="dsh-notifier-field__input"
                value={state.title.text}
                disabled={disabled}
                onChange={(event) => { props.editTitle(event.target.value) }}
              />
              <p className="dsh-notifier-field__hint">{t('titleFieldHint')}</p>
            </div>
            <div className="dsh-notifier-card__footer">
              <button
                type="button"
                className="dsh-notifier-card__test"
                onClick={() => { props.testNotification(t('testBody')) }}
              >
                {t('test')}
              </button>
              {state.failed ? <p className="dsh-notifier-card__failed" role="status">{t('saveFailed')}</p> : null}
              <button
                type="button"
                className="dsh-notifier-card__discard"
                disabled={!state.dirty || state.saving}
                onClick={props.discard}
              >
                {t('discard')}
              </button>
              <button
                type="button"
                className="dsh-notifier-card__save"
                disabled={!state.dirty || state.saving}
                onClick={props.save}
              >
                {t(state.saving ? 'saving' : 'save')}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}
