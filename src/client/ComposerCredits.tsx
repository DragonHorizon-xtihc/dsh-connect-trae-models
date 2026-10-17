/**
 * 对话栏（composer）工具行里的积分读数 + 切换用户面板。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 该项目的 `client/ComposerCredits.tsx`：同样的「触发器显示读数 → 点开面板
 *   列出账号 → 点一行切换」结构，同样的「非本插件模型时渲染空」门控，同样的
 *   「面板打开时才逐账号读余额」省额策略，以及 `set()` 成功不等于写入落盘的
 *   教训（这里改为显式路由写入，见 `switchTo`）。
 *
 * 与参照实现的一处刻意差异：切换账号走插件自己的
 * `/accounts/select` 路由（写 `pool.prefer`），而不是写 settings 槽位。原因
 * 是本插件的多账号是**同一个 provider 内部的轮转池**，不是「多套 provider 各绑
 * 一个账号」——把选择写进 settings 槽位不会改变任何派活行为，只会让界面上的
 * 选择与真正服务的账号脱节。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  TRAE_POOL_ACCOUNT_SELECT_PATH,
  TRAE_POOL_STATUS_PATH,
  withTraeRegion,
  type TraePoolRegion,
  type TraePoolWebAccount,
  type TraePoolWebStatus,
} from '../status-paths.ts'
import { useAnchoredPosition, useDismissOnOutsidePointer } from './popover.ts'
import { COMPOSER_CREDITS_CSS } from './styles.ts'
import type { TraePoolSettingsKey } from './locales.ts'

/**
 * 注入本组件的样式，且只注入一次。
 *
 * 必须自包含：对话栏这一行常驻，而插件设置卡片可能从未被打开（某些宿主上甚至
 * 不会挂载它）——把对话栏样式寄放在卡片 CSS 里，等于「卡片不开就完全无样式」，
 * 用户会看到一个没有边框、没有排版的原生按钮。
 */
if (typeof document !== 'undefined') {
  const cssId = 'dsh-connect-trae-models/composer-credits.css'
  if (!document.querySelector(`style[data-plugin-css="${cssId}"]`)) {
    const styleTag = document.createElement('style')
    styleTag.dataset.pluginCss = cssId
    styleTag.textContent = COMPOSER_CREDITS_CSS
    document.head.appendChild(styleTag)
  }
}

/**
 * 刷新间隔：五分钟，与积分的实际变化速率匹配。
 *
 * 积分以「模型调用」为尺度变化，不是以秒；每次读都是一次只读上游调用，所以按
 * 分钟级刷新既够用又不产生可观的请求量。
 */
export const COMPOSER_REFRESH_INTERVAL_MS = 300_000

/** 浏览器端注入的文案函数。 */
export interface ComposerCreditsInjected {
  /**
   * 文案函数。键集与卡片一致（`TraePoolSettingsKey`），而不是宽泛的 `string`：
   * 绑定的 locale 翻译器正是这个窄联合类型，把它声明成 `string` 会让编译器
   * 失去「键写错就报错」这道护栏（函数参数逆变，窄的不能赋给宽的）。
   */
  t: (key: TraePoolSettingsKey, params?: Record<string, unknown>) => string
  /** 当前会话选中的模型 provider；非本插件时组件渲染空。 */
  provider?: string
  /** 宿主提供的 settings 作用域（本组件不依赖它，只用于判断是否可写）。 */
  settingsScope?: { getSnapshot(): { writable?: boolean } }
}

/** provider id → 区域。非本插件的 provider 返回 undefined，门控据此渲染空。 */
export const COMPOSER_PROVIDERS: Readonly<Record<string, TraePoolRegion>> = {
  'connect-trae-models': 'cn',
  'connect-trae-models-global': 'ai',
}

export interface ComposerCreditsProps extends Partial<ComposerCreditsInjected> {}

/** 积分格式化：整数不带小数，小数保留两位并去掉尾零。 */
export function formatCredits(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(2).replace(/\.?0+$/, '')
}

/** 一个账号行的展示形状（从状态文档里挑出面板需要的字段）。 */
export interface ComposerAccountRow {
  id: string
  label: string
  disabled: boolean
  cooling: boolean
  available?: number
  preferred: boolean
}

/**
 * 从状态文档挑出面板要显示的账号行。
 *
 * 只保留**参与轮转**的账号：已被停用的账号不出现在切换列表里——把它列出来再
 * 标一个「不可用」，等于邀请用户点一个注定不生效的行。
 */
export function toComposerRows(status: TraePoolWebStatus | undefined): ComposerAccountRow[] {
  if (status === undefined) return []
  return status.accounts
    .filter(account => !account.disabled)
    .map(account => ({
      id: account.id,
      label: account.label,
      disabled: account.disabled,
      cooling: account.cooling,
      ...account.credits === undefined ? {} : { available: account.credits.available },
      preferred: status.preferredAccountId === account.id,
    }))
}

export function ComposerCredits(props: ComposerCreditsProps) {
  const { t, provider, settingsScope } = props
  if (t === undefined) throw new Error('Trae composer credits require a translation function')
  const region = provider === undefined ? undefined : COMPOSER_PROVIDERS[provider]

  const [status, setStatus] = useState<TraePoolWebStatus | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [switchingId, setSwitchingId] = useState<string | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const position = useAnchoredPosition({
    open: open && region !== undefined,
    anchorRef: rootRef,
    panelRef,
    // 向上弹：composer 在窗口底部，向下会开出屏幕。
    side: 'top',
    gap: 8,
    margin: 12,
  })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (inFlight.current || region === undefined) return
    inFlight.current = true
    try {
      const response = await fetch(withTraeRegion(TRAE_POOL_STATUS_PATH, region), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = await response.json() as TraePoolWebStatus
      if (!mounted.current || signal?.aborted === true) return
      setStatus(value)
      setFailed(false)
    } catch {
      // 保留上一次的读数：对一个几乎没变化的余额来说，陈旧的数字好过空白。
      if (mounted.current && signal?.aborted !== true) setFailed(true)
    } finally {
      inFlight.current = false
    }
  }, [region])

  useEffect(() => {
    if (region === undefined) return undefined
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = setInterval(() => { void refresh() }, COMPOSER_REFRESH_INTERVAL_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [region, refresh])

  /**
   * 切到另一个账号，然后重新读一次状态文档，让读数与面板一起更新。
   *
   * 写入必须**回读校验**：网络往返成功不等于状态真的变了。服务端先应用钉选再
   * 回读文档，若文档里 `preferredAccountId` 仍不是目标账号，就明确报失败，
   * 而不是留下一个「标记跳到别的账号」的行。
   */
  const switchTo = useCallback(async (accountId: string): Promise<void> => {
    if (region === undefined || switchingId !== undefined) return
    if (status?.preferredAccountId === accountId) return
    setSwitchingId(accountId)
    setFailed(false)
    try {
      const response = await fetch(withTraeRegion(TRAE_POOL_ACCOUNT_SELECT_PATH, region), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ accountId }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => undefined) as { error?: string } | undefined
        throw new Error(detail?.error ?? `HTTP ${response.status}`)
      }
      const controller = new AbortController()
      await refresh(controller.signal)
      controller.abort()
    } catch (error: unknown) {
      if (mounted.current) setFailed(true)
    } finally {
      if (mounted.current) setSwitchingId(undefined)
    }
  }, [region, status?.preferredAccountId, switchingId, refresh])

  // 不是本插件的模型：整行不渲染，让 composer 在别的 provider 下保持原样。
  //
  // 门控已经过滤，这里在正式接线下不会走到；但这是个公开组件，忘记判断的调用方
  // 不该在别的 provider 的模型旁边看到一个 Trae 余额。
  if (region === undefined) return null

  const rows = toComposerRows(status)
  const pinned = rows.find(row => row.preferred)
  // 读数优先给被钉住的账号；没钉选就给第一个可参与轮转的账号。
  const display = pinned?.available ?? rows[0]?.available
  const label = t(region === 'cn' ? 'composer.pointsCn' : 'composer.pointsGlobal')

  return (
    <span ref={rootRef} className="dsm-connect-trae-models-composer">
      <button
        type="button"
        className="dsm-connect-trae-models-composer-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        {label} · {formatCredits(display)}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className="dsm-connect-trae-models-composer-panel"
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          aria-label={t('composer.panelTitle')}
        >
          <div className="dsm-connect-trae-models-composer-head">
            <span className="dsm-connect-trae-models-composer-title">{t('composer.panelTitle')}</span>
            {failed ? <span className="dsm-connect-trae-models-warn">{t('composer.failed')}</span> : null}
          </div>
          {rows.length === 0
            ? <p className="dsm-connect-trae-models-composer-empty">{t('composer.noAccounts')}</p>
            : rows.map(row => (
              <button
                key={row.id}
                type="button"
                className="dsm-connect-trae-models-composer-row"
                aria-current={row.preferred === true}
                disabled={switchingId !== undefined}
                onClick={() => { void switchTo(row.id) }}
              >
                <span className="dsm-connect-trae-models-composer-name">{row.label}</span>
                {row.cooling === true
                  ? <span className="dsm-connect-trae-models-warn">{t('composer.cooling')}</span>
                  : <span className="dsm-connect-trae-models-composer-value">{formatCredits(row.available)}</span>}
                {row.preferred === true ? <span className="dsm-connect-trae-models-composer-pin">{t('composer.inUse')}</span> : null}
                {switchingId === row.id ? <span className="dsm-connect-trae-models-composer-value">{t('composer.switching')}</span> : null}
              </button>
            ))}
          <div className="dsm-connect-trae-models-composer-foot">
            <button
              type="button"
              className="dsm-connect-trae-models-composer-reset"
              disabled={status?.preferredAccountId === undefined || switchingId !== undefined}
              onClick={() => { void switchTo('') }}
            >
              {t('composer.clearPin')}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </span>
  )
}

/** 仅供测试与文档引用：面板只列出参与轮转的账号。 */
export type { TraePoolWebAccount }