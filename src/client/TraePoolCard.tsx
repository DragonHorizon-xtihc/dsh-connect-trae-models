/**
 * Trae Connect Models 设置卡片。
 *
 * 信息架构（分区顺序照 workbuddy 卡片的已验证布局）：
 *   1. 顶部：标题 + shim 状态 + 「重新检测账号」「清除所有冷却」
 *   2. 区域 Tab：国内版 / 国际版（各自账号、积分、模型）
 *   3. 账号池：每账号一行（开关、冷却、登录被拒、积分、到期提醒、签到）
 *   4. 积分自动化面板（总开关 + 立即运行 + 各 job 状态 + 今日收益）
 *   5. 模型管理（启用/图片/上下文预算 + 保存）
 *   6. 池健康汇总（账号数 · 冷却数 · 下一个轮到谁）
 *
 * 组件是被测的真实实现：tests/card.test.tsx 直接渲染它，不从副本断言。
 *
 * @module dsh-connect-trae-models/client/TraePoolCard
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_CHECKIN_HOURS,
  TRAE_POOL_ACCOUNT_TOGGLE_PATH,
  TRAE_POOL_AUTOMATION_RUN_PATH,
  TRAE_POOL_CHECKIN_PATH,
  TRAE_POOL_DEFAULT_REGION,
  TRAE_POOL_MODELS_SAVE_PATH,
  TRAE_POOL_RESCAN_PATH,
  TRAE_POOL_RESET_COOLDOWN_PATH,
  TRAE_POOL_STATUS_PATH,
  unwrapVolatileDeep,
} from '../status-paths.ts'
import type {
  TraeDistribution,
  TraePoolRegion,
  TraePoolWebAccount,
  TraePoolWebCheckinClaim,
  TraePoolWebCredits,
  TraePoolWebModel,
  TraePoolWebStatus,
} from '../status-paths.ts'
import type { TraePoolSettingsKey } from './locales.ts'
import { POOL_CARD_CSS } from './styles.ts'

/** 卡片允许的最小上下文预算（token）。
 *
 * 必须与服务端 `parseSelection` 的下限 1000 一致：前端若允许更小的值，用户会
 * 看到「输入生效」却在保存时被 400 拒绝。低于这个量级的窗口 DSH 也会以
 * `INVALID_MODEL_CONTEXT` 拒绝，本来就没有意义。
 */
const MIN_CONTEXT_BUDGET = 1000

/** 某个模型行的预算建议列表 id（`<input list>` 与 `<datalist id>` 共用）。 */
function budgetListId(modelId: string): string {
  return `trae-budget-options-${modelId}`
}

/** 卡片渲染所需的注入面。 */
export interface TraePoolCardInjected {
  t: (key: TraePoolSettingsKey, params?: Record<string, unknown>) => string
  /** 插件设置分区；缺省（锁定宿主）时卡片只读。 */
  settingsScope?: TraePoolCardSettingsScope
  /** 测试注入的 fetch；生产走全局 fetch。 */
  fetchImpl?: typeof fetch
}

/** 卡片用到的设置分区面（已收窄）。 */
export interface TraePoolCardSettingsScope {
  getSnapshot(): { writable?: boolean; value?: unknown }
  subscribe?(listener: () => void): () => void
  set?(field: string, value: unknown): Promise<void> | void
}

/** slot 交给卡片的 props。 */
export type TraePoolCardProps = Partial<TraePoolCardInjected> & {
  t?: (key: TraePoolSettingsKey, params?: Record<string, unknown>) => string
}

/** 状态轮询间隔：5 秒。 */
export const TRAE_POOL_POLL_MS = 5_000

/** 「即将到期」窗口：3 天（与上游 `expiringSoonWindowMs` 语义一致）。 */
const EXPIRING_SOON_MS = 3 * 24 * 60 * 60 * 1000

/** 卡片可选的五种账号使用方式，顺序即下拉框里的顺序。 */
const DISTRIBUTIONS: readonly TraeDistribution[] = ['priority', 'round-robin', 'balanced', 'sticky', 'expiry']

/** 取某个使用方式的名字。 */
function distributionLabel(t: PoolTranslator, mode: TraeDistribution): string {
  return t(`row.distribution.${mode}` as TraePoolSettingsKey)
}

/** 取某个使用方式的一句话说明。 */
function distributionHint(t: PoolTranslator, mode: TraeDistribution): string {
  return t(`row.distributionHint.${mode}` as TraePoolSettingsKey)
}

/** 卡片内部的文案函数形状。 */
type PoolTranslator = (key: TraePoolSettingsKey, params?: Record<string, unknown>) => string

/** 恒等翻译兜底（宿主未接 locale 时键名可见，好过白屏）。 */
const identityT = (key: TraePoolSettingsKey): string => key

/** 格式化一个毫秒时刻；无效返回 undefined。 */
function formatTime(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return new Date(ms).toISOString()
  }
}

/** 解析 ISO 时间戳为毫秒；无效返回 undefined。 */
function parseIso(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * 一个积分包的到期展示。
 *
 * 三种状态刻意分开：已过期只（灰）展示不告警，≤3 天（橙）告警，其余（弱色）
 * 只报时间。把「还没看」当成「马上到期」会让提醒失去意义。
 */
export interface ExpiryDisplay {
  kind: 'past' | 'soon' | 'future'
  /** 剩余整天数（向下取整，仅 soon/future 有意义）。 */
  days: number
  atMs: number
  /** 该包剩余额度。 */
  remaining: number
}

/** 计算一个积分包的到期展示；无有效到期时间返回 undefined。 */
export function expiryDisplayOf(pack: {
  endTimeMs: number
  creditsLimit?: number
  consumed?: number
}, nowMs: number): ExpiryDisplay | undefined {
  const atMs = pack.endTimeMs
  if (!Number.isFinite(atMs) || atMs <= 0) return undefined
  const remaining = Math.max(0, (pack.creditsLimit ?? 0) - (pack.consumed ?? 0))
  const left = atMs - nowMs
  if (left <= 0) return { kind: 'past', days: 0, atMs, remaining }
  const days = Math.floor(left / (24 * 60 * 60 * 1000))
  return { kind: left <= EXPIRING_SOON_MS ? 'soon' : 'future', days, atMs, remaining }
}

/** 取一个积分总览里最近的一笔未过期到期；全部已过期或无到期则 undefined。 */
function nearestUpcomingExpiry(credits: TraePoolWebCredits | undefined, nowMs: number): ExpiryDisplay | undefined {
  if (credits === undefined) return undefined
  let best: ExpiryDisplay | undefined
  for (const pack of credits.packs) {
    const display = expiryDisplayOf(pack, nowMs)
    if (display === undefined || display.kind === 'past') continue
    if (best === undefined || display.atMs < best.atMs) best = display
  }
  return best
}

/** 签到按钮的四种状态（测试按这个集合断言）。 */
export type CheckinState = 'claimed' | 'deviceSpent' | 'available' | 'disabled'

/**
 * 判定一个账号的签到按钮状态。
 *
 * 顺序有意义：账号级已领 → 设备级已用 → 活动未开启 → 可领取。
 * 把 `didCheckedIn`（设备级）当成「今天签过了」是一个已发生过的缺陷——切换账号
 * 后按钮会变灰，而新账号其实一分未得，所以两者必须分开表达。
 */
export function checkinStateOf(checkin: {
  enabled: boolean
  checkedIn: boolean
  didCheckedIn: boolean
} | undefined, deviceSpent?: boolean): CheckinState {
  if (checkin === undefined) return 'disabled'
  if (checkin.checkedIn) return 'claimed'
  if (checkin.didCheckedIn || deviceSpent === true) return 'deviceSpent'
  if (!checkin.enabled) return 'disabled'
  return 'available'
}

/** 判断一条请求是否可信地成功；返回解析后的 JSON 或抛错。 */
async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, init)
  let payload: Record<string, unknown> = {}
  try {
    payload = await response.json() as Record<string, unknown>
  } catch {
    payload = {}
  }
  if (!response.ok) {
    const message = typeof payload['error'] === 'string' ? payload['error'] : `HTTP ${response.status}`
    throw new Error(message)
  }
  return payload
}

/**
 * 服务卡片。
 *
 * 两个区域各自保留最后一次答案（不是单一槽位）：切换标签页时立刻显示另一侧的
 * 上一份结果，而不是一帧空白。
 */
export function TraePoolCard(props: TraePoolCardProps) {
  const t = props.t ?? identityT
  const fetchImpl = props.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
  const settingsScope = props.settingsScope
  /**
   * 模型设置是否可改。
   *
   * 只读**仅**当宿主明确报告作用域不可写时成立。作用域缺失（绑定探测失败、
   * 受限宿主）**不**等于只读：模型设置走 models/save HTTP 路由落盘，与 settings
   * 作用域无关，把「没绑定上作用域」当成只读会让这些宿主上根本无法编辑模型。
   */
  const scopeSnapshot = settingsScope?.getSnapshot()
  const modelsEditable = scopeSnapshot === undefined || scopeSnapshot.writable !== false

  const [activeRegion, setActiveRegion] = useState<TraePoolRegion>(TRAE_POOL_DEFAULT_REGION)
  const [statusByRegion, setStatusByRegion] = useState<Partial<Record<TraePoolRegion, TraePoolWebStatus>>>({})
  const [errorByRegion, setErrorByRegion] = useState<Partial<Record<TraePoolRegion, string>>>({})
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [checkinMessageByAccount, setCheckinMessageByAccount] = useState<Record<string, string>>({})
  /** 模型草稿：undefined 表示跟随服务器值。 */
  const [modelDraft, setModelDraft] = useState<
    Record<TraePoolRegion, { enabledModelIds: string[]; imageModelIds: string[]; contextBudgets: Record<string, number> } | undefined>
  >({ cn: undefined, ai: undefined })

  /** 样式只注入一次。 */
  useEffect(() => {
    if (typeof document === 'undefined') return
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-connect-trae-models'
    tag.dataset.pluginCss = 'dsh-connect-trae-models/card'
    tag.textContent = POOL_CARD_CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, [])

  /** 拉取一个区域的状态。 */
  const refresh = useCallback(async (region: TraePoolRegion): Promise<void> => {
    if (fetchImpl === undefined) return
    try {
      const payload = await requestJson(
        fetchImpl,
        `${TRAE_POOL_STATUS_PATH}?region=${region}`,
        { method: 'GET', headers: { Accept: 'application/json' } },
      )
      setStatusByRegion(current => ({ ...current, [region]: payload as unknown as TraePoolWebStatus }))
      setErrorByRegion(current => ({ ...current, [region]: undefined }))
    } catch (error: unknown) {
      setErrorByRegion(current => ({
        ...current,
        [region]: error instanceof Error ? error.message : String(error),
      }))
    }
  }, [fetchImpl])

  // 轮询：首次立即拉，之后每 5 秒一次。区域切换会立刻拉一次新区域。
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    void refreshRef.current(activeRegion)
    const timer = setInterval(() => { void refreshRef.current(activeRegion) }, TRAE_POOL_POLL_MS)
    return () => { clearInterval(timer) }
  }, [activeRegion])

  const status = statusByRegion[activeRegion]
  const error = errorByRegion[activeRegion]

  /** 用当前活跃区域重新读取配置（模型草稿回退用）。 */
  const reloadConfig = useCallback((): void => {
    // 服务器值是唯一真相；草稿清空即回到它。
    setModelDraft(current => ({ ...current, [activeRegion]: undefined }))
  }, [activeRegion])

  /** 发一个 POST 并刷新。 */
  const post = useCallback(async (
    url: string,
    body: Record<string, unknown>,
    busyKey: string,
  ): Promise<Record<string, unknown> | undefined> => {
    if (fetchImpl === undefined) return undefined
    setBusy(busyKey)
    setNotice(undefined)
    try {
      const payload = await requestJson(fetchImpl, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      await refreshRef.current(activeRegion)
      return payload
    } catch (err: unknown) {
      setNotice(err instanceof Error ? err.message : String(err))
      return undefined
    } finally {
      setBusy(undefined)
    }
  }, [fetchImpl, activeRegion])

  const regionLabel = activeRegion === 'cn' ? t('row.regionCn') : t('row.regionAi')

  /** 模型行（草稿优先）。 */
  const models: readonly TraePoolWebModel[] = useMemo(() => status?.models ?? [], [status])

  const draft = modelDraft[activeRegion]
  const effectiveDraft = useMemo(() => {
    if (draft !== undefined) return draft
    const selection = status?.selection
    // 服务端逐行给出的 `enabled` 已经是三态解析后的真实状态（缺失 = 全部启用、
    // `[]` = 全部停用），所以这里直接照抄即可，不需要再判断空数组。
    const enabled = models.filter(model => model.enabled).map(model => model.id)
    const images = models.filter(model => model.supportsImages).map(model => model.id)
    const budgets: Record<string, number> = {}
    for (const model of models) {
      if (model.contextWindow !== model.nativeContextWindow) budgets[model.id] = model.contextWindow
    }
    return {
      enabledModelIds: [...(selection?.enabledModelIds ?? enabled)],
      imageModelIds: [...(selection?.imageModelIds ?? images)],
      contextBudgets: { ...(selection?.contextBudgets ?? budgets) },
    }
  }, [draft, status, models])

  /** 当前草稿里被启用的模型数（用于批量勾选条的三态文案）。 */
  const enabledCount = useMemo(() => {
    const ids = new Set(effectiveDraft.enabledModelIds)
    return models.filter(model => ids.has(model.id)).length
  }, [effectiveDraft, models])

  /** 当前草稿里是否有任何一个模型被启用。 */
  const anyEnabled = enabledCount > 0

  const setDraft = useCallback((next: typeof effectiveDraft): void => {
    setModelDraft(current => ({ ...current, [activeRegion]: next }))
  }, [activeRegion])

  /** 全选：把全量模型都写进启用列表（而不是留空表示「全部启用」）。 */
  const selectAllModels = useCallback((): void => {
    setDraft({ ...effectiveDraft, enabledModelIds: models.map(model => model.id) })
  }, [setDraft, effectiveDraft, models])

  /**
   * 取消全选：落成**显式空数组**。
   *
   * `[]` 与「缺失」是两件事：缺失 = 全部启用，`[]` = 用户逐个停用。只有写空
   * 数组才能表达「一个都不要」，所以这里绝不能退化成删键。
   */
  const selectNoModels = useCallback((): void => {
    setDraft({ ...effectiveDraft, enabledModelIds: [] })
  }, [setDraft, effectiveDraft])

  const saveModels = useCallback(async (): Promise<void> => {
    // 原样保存勾选集，包括空数组。
    //
    // 旧实现在这里把空选集展开成「全部模型 id」，理由是「空选集会让选择器整个
    // 空掉」。但空选集本来就是用户的合法选择（全部停用），而且卡片现在列的是
    // 全量模型，停用后随时能勾回来。展开成全部 id 只会让「取消全选 + 保存」
    // 静默变成「全选」，让这个按钮变成摆设。
    const payload = await post(TRAE_POOL_MODELS_SAVE_PATH, {
      region: activeRegion,
      enabledModelIds: effectiveDraft.enabledModelIds,
      imageModelIds: effectiveDraft.imageModelIds,
      contextBudgets: effectiveDraft.contextBudgets,
    }, 'models')
    if (payload !== undefined) {
      setNotice(t('row.modelsSaved'))
      reloadConfig()
    }
  }, [post, activeRegion, effectiveDraft, t, reloadConfig])

  /**
   * 切换账号使用方式（写 settings，不走 HTTP 路由）。
   *
   * 与自动化开关一样按**顶层键**写：`distribution` 是设置文档里的一个顶层字段，
   * 用点号路径会被当成字面键名而永不生效。写完立即重读，好让卡片上的「当前方式」
   * 与真正派发用的值一致——读回来的文档才是事实。
   */
  const setDistribution = useCallback(async (next: TraeDistribution): Promise<void> => {
    const write = settingsScope?.set
    if (write === undefined) {
      setNotice(t('row.modelsSaveFailed', { message: 'settings scope is unavailable' }))
      return
    }
    setBusy('distribution')
    setNotice(undefined)
    try {
      await write.call(settingsScope, 'distribution', next)
      await refreshRef.current(activeRegion)
    } catch (error: unknown) {
      setNotice(t('row.modelsSaveFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(undefined)
    }
  }, [settingsScope, activeRegion, t])

  /**
   * 切换自动化总开关（写 settings，不走 HTTP 路由）。
   *
   * `automation` 必须作为**整个对象**写入：settings 文档按顶层键存它，用点号
   * 路径 `'automation.enabled'` 会被当成一个字面键名，真正的 automation 对象
   * 永不更新——这正是「复选框勾不动」的成因。
   *
   * 写入时要把小时列表一并带上：它们决定调度时刻，只写 `enabled` 会把已有
   * 配置丢成 schema 缺省；列表为空时回落到宿主的默认时刻，这样一份被写成
   * `[]` 的文档也会被下一次切换治愈，而不是存成一份跑不起来的日程。
   */
  const toggleAutomation = useCallback(async (enabled: boolean): Promise<void> => {
    const write = settingsScope?.set
    if (write === undefined) {
      setNotice(t('row.autoEnableFailed', { message: 'settings scope is unavailable' }))
      return
    }
    setBusy('automation')
    setNotice(undefined)
    try {
      const existing = status?.automation
      const hours = existing?.checkinHours ?? []
      await write.call(settingsScope, 'automation', {
        enabled,
        checkinHours: hours.length > 0 ? [...hours] : [...DEFAULT_CHECKIN_HOURS],
      })
      await refreshRef.current(activeRegion)
    } catch (error: unknown) {
      setNotice(t('row.autoEnableFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(undefined)
    }
  }, [settingsScope, activeRegion, t, status])

  /** 手动签到一个账号。 */
  const claimCheckin = useCallback(async (account: TraePoolWebAccount): Promise<void> => {
    const payload = await post(TRAE_POOL_CHECKIN_PATH, { accountId: account.id, region: activeRegion }, `checkin:${account.id}`)
    if (payload === undefined) return
    const result = payload as unknown as TraePoolWebCheckinClaim
    const code = result.code
    const credits = result.checkin?.credits
    let message: string
    if (result.claimed) {
      message = t('row.checkinDone', { credits: credits ?? 0 })
    } else if (result.alreadyCheckedIn) {
      message = t('row.checkinAlready')
    } else if (result.deviceCheckedIn) {
      message = t('row.checkinDeviceDone')
    } else {
      message = t('row.checkinRefused')
    }
    if (code !== undefined && code !== 0) message = `${message} · ${t('row.checkinCode', { code })}`
    setCheckinMessageByAccount(current => ({ ...current, [account.id]: message }))
  }, [post, activeRegion, t])

  const accounts = status?.accounts ?? []
  const coolingCount = status?.cooling ?? 0
  const activeAccount = accounts.find(account => account.id === status?.activeAccountId)

  /** 今日自动化收益（按账号名展示，账号找不到时退回 id 前 8 位）。 */
  const earningsRows = useMemo(() => {
    const earnings = status?.automation?.earningsToday ?? {}
    return Object.entries(earnings).map(([accountId, entry]) => {
      const account = accounts.find(candidate => candidate.id === accountId)
      return {
        accountId,
        name: account?.label ?? `${accountId.slice(0, 8)}#`,
        credit: entry.credit,
        deviceSpent: entry.deviceSpent === true,
      }
    })
  }, [status, accounts])

  const nowMs = Date.now()

  return (
    <div className="dsm-connect-trae-models-page">
      <div className="dsm-connect-trae-models-page-head">
        <div className="dsm-connect-trae-models-page-copy">
          <h2 className="dsm-connect-trae-models-page-title">{t('row.title')}</h2>
          <p className="dsm-connect-trae-models-page-desc">{t('row.desc')}</p>
        </div>
        <div className="dsm-connect-trae-models-page-actions">
          <button
            type="button"
            className="dsm-btn dsm-btn-outline"
            disabled={busy !== undefined}
            onClick={() => {
              void (async () => {
                const payload = await post(TRAE_POOL_RESCAN_PATH, { region: activeRegion }, 'rescan')
                if (payload !== undefined) {
                  const count = typeof payload['count'] === 'number' ? payload['count'] : accounts.length
                  setNotice(t('row.rescanDone', { count }))
                }
              })()
            }}
          >
            {busy === 'rescan' ? t('row.rescanning') : t('row.rescan')}
          </button>
          <button
            type="button"
            className="dsm-btn dsm-btn-outline"
            disabled={busy !== undefined}
            onClick={() => {
              void (async () => {
                const payload = await post(TRAE_POOL_RESET_COOLDOWN_PATH, { region: activeRegion }, 'reset')
                if (payload !== undefined) setNotice(t('row.resetDone'))
              })()
            }}
          >
            {busy === 'reset' ? t('row.resetting') : t('row.resetCooldowns')}
          </button>
        </div>
      </div>

      {/* shim 状态 + 池健康汇总 */}
      <div className="dsm-connect-trae-models-card">
        <div className="dsm-connect-trae-models-status-line">
          <span className={`dsm-connect-trae-models-dot ${status?.shim.running === true ? 'dsm-connect-trae-models-dot-ok' : 'dsm-connect-trae-models-dot-bad'}`} />
          <span className="dsm-connect-trae-models-secondary">
            {status?.shim.running === true ? t('row.shimRunning') : t('row.shimStopped')}
          </span>
          {status?.shim.baseUrl !== undefined && (
            <span className="dsm-connect-trae-models-muted">{status.shim.baseUrl}</span>
          )}
        </div>

        <div className="dsm-connect-trae-models-status-line">
          <span className={`dsm-connect-trae-models-dot ${coolingCount > 0 ? 'dsm-connect-trae-models-dot-warn' : accounts.length > 0 ? 'dsm-connect-trae-models-dot-ok' : ''}`} />
          <span className="dsm-connect-trae-models-secondary">
            {t('row.healthSummary', { count: accounts.length, cooling: coolingCount })}
          </span>
          <span className="dsm-connect-trae-models-muted">
            {activeAccount === undefined
              ? t('row.activeAccountNone')
              : t('row.activeAccount', { name: activeAccount.label })}
          </span>
        </div>

        <div className="dsm-connect-trae-models-status-line">
          <span className="dsm-connect-trae-models-muted">
            {accounts.length === 0
              ? t('row.emptyReason')
              : coolingCount >= accounts.length && accounts.length > 0
                ? t('row.allCooling')
                : t('row.ok')}
          </span>
        </div>

        {status?.distribution !== undefined && (
          <div className="dsm-connect-trae-models-status-line">
            <label className="dsm-connect-trae-models-field">
              <span className="dsm-connect-trae-models-muted">{t('row.distributionLabel')}</span>
              <select
                aria-label={t('row.distributionLabel')}
                value={status.distribution}
                disabled={!modelsEditable || busy !== undefined}
                onChange={event => { void setDistribution(event.target.value as TraeDistribution) }}
              >
                {DISTRIBUTIONS.map(option => (
                  <option key={option} value={option}>{distributionLabel(t, option)}</option>
                ))}
              </select>
            </label>
            <span className="dsm-connect-trae-models-muted">
              {distributionHint(t, status.distribution as TraeDistribution)}
            </span>
            <span className="dsm-connect-trae-models-muted">
              {status.catalogSource === 'live' ? t('row.catalogSourceLive') : t('row.catalogSourceFallback')}
            </span>
          </div>
        )}

        {status?.catalogError !== undefined && (
          <p className="dsm-connect-trae-models-error">{t('row.catalogError', { message: status.catalogError })}</p>
        )}

        {/* 区域 Tab */}
        <div className="dsm-connect-trae-models-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className="dsm-connect-trae-models-tab"
            aria-selected={activeRegion === 'cn'}
            onClick={() => setActiveRegion('cn')}
          >
            {t('row.regionCn')}
          </button>
          <button
            type="button"
            role="tab"
            className="dsm-connect-trae-models-tab"
            aria-selected={activeRegion === 'ai'}
            onClick={() => setActiveRegion('ai')}
          >
            {t('row.regionAi')}
          </button>
        </div>

        {error !== undefined && (
          <p className="dsm-connect-trae-models-error">{t('row.requestFailed')}: {error}</p>
        )}
        {notice !== undefined && (
          <p className="dsm-connect-trae-models-muted">{notice}</p>
        )}
      </div>

      {/* 空区域指引 */}
      {status !== undefined && accounts.length === 0 && (
        <div className="dsm-connect-trae-models-card dsm-connect-trae-models-empty">
          <h3 className="dsm-connect-trae-models-empty-title">{t('row.regionEmptyTitle', { region: regionLabel })}</h3>
          <div className="dsm-connect-trae-models-empty-steps">
            <p className="dsm-connect-trae-models-empty-steps-title">{t('row.regionHowToTitle', { region: regionLabel })}</p>
            <ol className="dsm-connect-trae-models-empty-list">
              <li>{t('row.regionHowTo1')}</li>
              <li>{t('row.regionHowTo2')}</li>
              <li>{t('row.regionHowTo3')}</li>
            </ol>
            <p className="dsm-connect-trae-models-empty-note">{t('row.regionHowToNote')}</p>
          </div>
        </div>
      )}

      {/* 账号池 */}
      {accounts.length > 0 && (
        <div className="dsm-connect-trae-models-card">
          <h3 className="dsm-connect-trae-models-section-title">{t('row.accountsTitle')}</h3>
          {accounts.map(account => (
            <AccountRow
              key={account.id}
              t={t}
              account={account}
              nowMs={nowMs}
              isActive={account.id === status?.activeAccountId}
              busy={busy}
              checkinMessage={checkinMessageByAccount[account.id]}
              onToggle={disabled => {
                void post(TRAE_POOL_ACCOUNT_TOGGLE_PATH, { accountId: account.id, disabled }, `toggle:${account.id}`)
              }}
              onCheckin={() => { void claimCheckin(account) }}
            />
          ))}
        </div>
      )}

      {/* 自动化面板 */}
      {status?.automation !== undefined && (
        <div className="dsm-connect-trae-models-card">
          <h3 className="dsm-connect-trae-models-section-title">{t('row.autoTitle')}</h3>
          <label className="dsm-connect-trae-models-toggle">
            <input
              type="checkbox"
              aria-label={t('row.autoEnable')}
              checked={status.automation.enabled}
              disabled={busy !== undefined || (settingsScope?.set === undefined)}
              onChange={event => { void toggleAutomation(event.target.checked) }}
            />
            <span>{t('row.autoEnable')}</span>
          </label>
          <p className="dsm-connect-trae-models-section-hint">{t('row.autoEnableHint')}</p>
          <p className="dsm-connect-trae-models-section-hint">
            {t('row.autoHours', { hours: status.automation.checkinHours.join(', ') })}
          </p>
          <div className="dsm-connect-trae-models-checkin-row">
            <button
              type="button"
              className="dsm-btn dsm-btn-primary"
              disabled={busy !== undefined || status.automation.runInProgress}
              onClick={() => {
                void (async () => {
                  const payload = await post(TRAE_POOL_AUTOMATION_RUN_PATH, { region: activeRegion }, 'auto-run')
                  if (payload === undefined) return
                  const started = payload['started'] === true
                  setNotice(started ? t('row.autoRunStarted') : t('row.autoAlreadyRunning'))
                })()
              }}
            >
              {status.automation.runInProgress || busy === 'auto-run' ? t('row.autoRunning') : t('row.autoRun')}
            </button>
          </div>

          <div className="dsm-connect-trae-models-status-line">
            <span className="dsm-connect-trae-models-secondary">{t('row.autoJobTitle')}</span>
            <span className="dsm-connect-trae-models-muted">
              {status.automation.jobs.checkin.lastRunAtMs === undefined
                ? t('row.autoNeverRun')
                : t('row.autoLastRun', { time: formatTime(status.automation.jobs.checkin.lastRunAtMs) ?? '' })}
            </span>
          </div>
          <p className="dsm-connect-trae-models-section-hint">
            {t('row.autoCounts', {
              ok: status.automation.jobs.checkin.ok,
              failed: status.automation.jobs.checkin.failed,
              claimed: status.automation.jobs.checkin.claimed,
              deviceSpent: status.automation.jobs.checkin.deviceSpent,
            })}
            {' · '}
            {t('row.autoCredit', { credit: status.automation.jobs.checkin.credit })}
          </p>
          {(status.automation.jobs.checkin.detail ?? []).length > 0 && (
            <ul className="dsm-connect-trae-models-detail">
              {(status.automation.jobs.checkin.detail ?? []).map((line, index) => (
                <li key={`${index}-${line}`}>{line}</li>
              ))}
            </ul>
          )}

          <h4 className="dsm-connect-trae-models-section-title">{t('row.autoTodayTitle')}</h4>
          {earningsRows.length === 0
            ? <p className="dsm-connect-trae-models-section-hint">{t('row.autoTodayNone')}</p>
            : (
              <ul className="dsm-connect-trae-models-earnings">
                {earningsRows.map(row => (
                  <li key={row.accountId}>
                    {row.deviceSpent
                      ? t('row.autoDeviceSpentToday', { name: row.name })
                      : t('row.autoTodayAccount', { name: row.name, credit: row.credit })}
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}

      {/* 模型管理 */}
      {models.length > 0 && (
        <div className="dsm-connect-trae-models-card">
          <h3 className="dsm-connect-trae-models-section-title">
            {t('row.modelsTitle')}
            {draft !== undefined && <span className="dsm-connect-trae-models-warn"> · {t('row.modelsDirty')}</span>}
          </h3>
          <p className="dsm-connect-trae-models-section-hint">{t('row.modelsHint')}</p>
          {!modelsEditable && <p className="dsm-connect-trae-models-section-hint">{t('row.modelsReadonly')}</p>}
          {models.length > 0 && (
            <div className="dsm-connect-trae-models-model-bulk">
              <button
                type="button"
                className="dsm-btn dsm-btn-secondary"
                disabled={!modelsEditable || enabledCount === models.length}
                onClick={selectAllModels}
              >
                {t('row.modelsSelectAll')}
              </button>
              <button
                type="button"
                className="dsm-btn dsm-btn-secondary"
                disabled={!modelsEditable || !anyEnabled}
                onClick={selectNoModels}
              >
                {t('row.modelsSelectNone')}
              </button>
              <span className="dsm-connect-trae-models-model-bulk-state">
                {enabledCount === 0
                  ? t('row.modelsAllDisabled')
                  : enabledCount === models.length
                    ? t('row.modelsAllEnabled')
                    : t('row.modelsSomeEnabled', { enabled: enabledCount, total: models.length })}
              </span>
            </div>
          )}
          {models.map(model => (
            <ModelRow
              key={model.id}
              t={t}
              model={model}
              enabled={effectiveDraft.enabledModelIds.includes(model.id)}
              images={effectiveDraft.imageModelIds.includes(model.id)}
              budget={effectiveDraft.contextBudgets[model.id]}
              disabled={!modelsEditable}
              onToggleEnabled={next => setDraft({
                ...effectiveDraft,
                enabledModelIds: next
                  ? [...new Set([...effectiveDraft.enabledModelIds, model.id])]
                  : effectiveDraft.enabledModelIds.filter(id => id !== model.id),
              })}
              onToggleImages={next => setDraft({
                ...effectiveDraft,
                imageModelIds: next
                  ? [...new Set([...effectiveDraft.imageModelIds, model.id])]
                  : effectiveDraft.imageModelIds.filter(id => id !== model.id),
              })}
              onBudgetChange={next => {
                const budgets = { ...effectiveDraft.contextBudgets }
                if (next === undefined) delete budgets[model.id]
                else budgets[model.id] = next
                setDraft({ ...effectiveDraft, contextBudgets: budgets })
              }}
            />
          ))}
          <div className="dsm-connect-trae-models-page-actions">
            <button
              type="button"
              className="dsm-btn dsm-btn-primary"
              disabled={busy !== undefined || !modelsEditable}
              onClick={() => { void saveModels() }}
            >
              {busy === 'models' ? t('row.modelsSaving') : t('row.modelsSave')}
            </button>
            <button type="button" className="dsm-btn dsm-btn-outline" onClick={reloadConfig}>
              {t('row.refresh')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** 一个账号行。 */
function AccountRow(props: {
  t: (key: TraePoolSettingsKey, params?: Record<string, unknown>) => string
  account: TraePoolWebAccount
  nowMs: number
  isActive: boolean
  busy: string | undefined
  checkinMessage: string | undefined
  onToggle: (disabled: boolean) => void
  onCheckin: () => void
}) {
  const { t, account, nowMs, isActive, busy, checkinMessage, onToggle, onCheckin } = props

  const cooldownUntil = parseIso(account.cooldownUntil)
  const expiresAt = parseIso(account.expiresAt)
  const credentialDeadUntil = parseIso(account.credentialDeadUntil)
  const lastUsedAt = parseIso(account.lastUsedAt)
  const credits = account.credits
  const upcoming = nearestUpcomingExpiry(credits, nowMs)
  const checkinState = checkinStateOf(account.checkin, account.deviceSpent)
  const claiming = busy === `checkin:${account.id}`

  return (
    <div className="dsm-connect-trae-models-account">
      <div className="dsm-connect-trae-models-account-head">
        <span className="dsm-connect-trae-models-account-name">{account.label}</span>
        <span className="dsm-connect-trae-models-account-tags">
          {isActive && <span className="dsm-connect-trae-models-tag dsm-connect-trae-models-tag-ok">{t('row.activeAccount', { name: account.label })}</span>}
          {account.disabled && <span className="dsm-connect-trae-models-tag dsm-connect-trae-models-tag-neutral">{t('row.accountOffTag')}</span>}
          {account.credentialDead === true && (
            <span className="dsm-connect-trae-models-tag dsm-connect-trae-models-tag-danger">{t('row.credentialDead')}</span>
          )}
          {account.cooling && <span className="dsm-connect-trae-models-tag dsm-connect-trae-models-tag-warn">{t('row.cooling')}</span>}
          {account.reserved && <span className="dsm-connect-trae-models-tag dsm-connect-trae-models-tag-warn">{t('row.reserved')}</span>}
        </span>
        <label className="dsm-connect-trae-models-toggle" title={t('row.accountToggleHint')}>
          <input
            type="checkbox"
            aria-label={`${t('row.accountInRotation')} ${account.label}`}
            checked={!account.disabled}
            disabled={busy !== undefined}
            onChange={event => onToggle(!event.target.checked)}
          />
          <span>{account.disabled ? t('row.accountOff') : t('row.accountInRotation')}</span>
        </label>
      </div>

      <div className="dsm-connect-trae-models-account-meta">
        {expiresAt === undefined
          ? <span>{t('row.tokenExpiryNone')}</span>
          : <span>{t('row.tokenExpiry', { time: formatTime(expiresAt) ?? '' })}</span>}
        {cooldownUntil !== undefined && account.cooling && (
          <span className="dsm-connect-trae-models-warn">{t('row.coolingUntil', { time: formatTime(cooldownUntil) ?? '' })}</span>
        )}
        {credentialDeadUntil !== undefined && account.credentialDead === true && (
          <span className="dsm-connect-trae-models-danger">{t('row.credentialDeadHint')}</span>
        )}
        {account.rateLimitHits > 0 && <span>{t('row.rateLimitHits', { hits: account.rateLimitHits })}</span>}
        {lastUsedAt === undefined
          ? <span>{t('row.neverUsed')}</span>
          : <span>{t('row.lastUsed', { time: formatTime(lastUsedAt) ?? '' })}</span>}
      </div>

      {(account.modelCooldowns ?? []).length > 0 && (
        <div className="dsm-connect-trae-models-account-facts">
          <span className="dsm-connect-trae-models-muted">{t('row.modelCoolingTitle')}:</span>
          {(account.modelCooldowns ?? []).map(entry => (
            <span key={entry.modelId}>
              {t('row.modelCooling', {
                model: entry.modelId,
                time: formatTime(parseIso(entry.until)) ?? '',
              })}
            </span>
          ))}
        </div>
      )}

      {/* 积分 + 到期提醒 */}
      <div className="dsm-connect-trae-models-account-facts">
        {account.creditsError !== undefined && (
          <span className="dsm-connect-trae-models-muted">{t('row.creditsError')}</span>
        )}
        {account.creditsError === undefined && credits === undefined && (
          <span className="dsm-connect-trae-models-muted">
            <span className="dsm-connect-trae-models-secondary">{t('row.creditsTitle')}</span>
            {' '}{t('row.creditsLoading')}
          </span>
        )}
        {credits !== undefined && (
          <>
            <span>
              <span className="dsm-connect-trae-models-muted">{t('row.creditsTotal')}</span>
              {' '}<span className="dsm-connect-trae-models-secondary">{credits.total}</span>
              {' · '}{t('row.creditsAvailable', { count: credits.available })}
              {' · '}{t('row.creditsConsumed', { count: credits.consumed })}
            </span>
            {credits.expiringSoon !== undefined && credits.expiringSoon > 0 && (
              <span className="dsm-connect-trae-models-tag dsm-connect-trae-models-tag-warn">
                {t('row.creditsSoonBadge', { count: credits.expiringSoon })}
              </span>
            )}
          </>
        )}
      </div>

      {/* 到期提醒：≤3 天橙色，已过期灰显 */}
      {credits !== undefined && (
        <ExpiryLine t={t} credits={credits} upcoming={upcoming} nowMs={nowMs} />
      )}

      {/* 积分包明细 */}
      {credits !== undefined && credits.packs.length > 0 && (
        <table className="dsm-connect-trae-models-packs">
          <thead>
            <tr>
              <th>{t('row.creditsPackages')}</th>
              <th>{t('row.creditsTotal')}</th>
              <th>{t('row.creditsExpiresAt', { time: '' }).split(' ')[0]}</th>
            </tr>
          </thead>
          <tbody>
            {credits.packs.map((pack, index) => {
              const display = expiryDisplayOf(pack, nowMs)
              const remaining = Math.max(0, (pack.creditsLimit ?? 0) - (pack.consumed ?? 0))
              return (
                <tr key={`${pack.displayDesc}-${index}`}>
                  <td>{pack.displayDesc}</td>
                  <td>
                    {pack.creditsLimit === undefined
                      ? t('row.creditsPackageNoQuota', { remain: remaining })
                      : t('row.creditsPackage', { remain: remaining, size: pack.creditsLimit })}
                  </td>
                  <td className={display?.kind === 'soon'
                    ? 'dsm-connect-trae-models-expiry-soon'
                    : display?.kind === 'past' ? 'dsm-connect-trae-models-expiry-past' : undefined}
                  >
                    {display === undefined ? '—' : formatTime(display.atMs)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {/* 签到块 */}
      <div className="dsm-connect-trae-models-checkin">
        <div className="dsm-connect-trae-models-checkin-row">
          <span className="dsm-connect-trae-models-checkin-text">
            {checkinState === 'claimed' && t('row.checkinClaimed', { credits: account.checkin?.credits ?? 0 })}
            {checkinState === 'deviceSpent' && t('row.checkinDeviceSpent')}
            {checkinState === 'disabled' && t('row.checkinDisabled')}
            {checkinState === 'available' && t('row.checkinAvailable', { credits: account.checkin?.credits ?? 0 })}
          </span>
          <button
            type="button"
            className="dsm-btn dsm-btn-primary dsm-btn-sm"
            disabled={checkinState !== 'available' || claiming || busy !== undefined}
            onClick={onCheckin}
          >
            {claiming ? t('row.checkinClaiming') : t('row.checkinClaim')}
          </button>
        </div>
        {checkinState === 'deviceSpent' && (
          <p className="dsm-connect-trae-models-section-hint">{t('row.checkinDeviceSpentHint')}</p>
        )}
        {checkinState === 'disabled' && (
          <p className="dsm-connect-trae-models-section-hint">{t('row.checkinDisabledHint')}</p>
        )}
        {account.checkinError !== undefined && (
          <p className="dsm-connect-trae-models-muted">{t('row.checkinError')}</p>
        )}
        {checkinMessage !== undefined && (
          <p className="dsm-connect-trae-models-checkin-msg dsm-connect-trae-models-secondary">{checkinMessage}</p>
        )}
      </div>
    </div>
  )
}

/** 到期提醒行。 */
function ExpiryLine(props: {
  t: (key: TraePoolSettingsKey, params?: Record<string, unknown>) => string
  credits: TraePoolWebCredits
  upcoming: ExpiryDisplay | undefined
  nowMs: number
}) {
  const { t, credits, upcoming, nowMs } = props

  // 最近的未过期包：≤3 天橙色告警，其余弱色只报时间。
  if (upcoming !== undefined) {
    if (upcoming.kind === 'soon') {
      const text = upcoming.days <= 0
        ? t('row.creditsExpiresToday', { credits: upcoming.remaining })
        : t('row.creditsExpiresInDays', { days: upcoming.days, credits: upcoming.remaining })
      return (
        <p className="dsm-connect-trae-models-expiry dsm-connect-trae-models-expiry-soon">
          {t('row.creditsExpiresSoonTitle')}：{text}（{formatTime(upcoming.atMs)}）
        </p>
      )
    }
    return (
      <p className="dsm-connect-trae-models-expiry dsm-connect-trae-models-expiry-future">
        {t('row.creditsExpiresAt', { time: formatTime(upcoming.atMs) ?? '' })}
      </p>
    )
  }

  // 没有未过期的包：若有已过期的，灰显最最近的一条；否则说明「没有带截止时间的包」。
  let latestPast: ExpiryDisplay | undefined
  for (const pack of credits.packs) {
    const display = expiryDisplayOf(pack, nowMs)
    if (display === undefined || display.kind !== 'past') continue
    if (latestPast === undefined || display.atMs > latestPast.atMs) latestPast = display
  }
  if (latestPast !== undefined) {
    return (
      <p className="dsm-connect-trae-models-expiry dsm-connect-trae-models-expiry-past">
        {t('row.creditsExpired', {
          time: formatTime(latestPast.atMs) ?? '',
          credits: latestPast.remaining,
        })}
      </p>
    )
  }
  if (credits.packs.length > 0) {
    return <p className="dsm-connect-trae-models-expiry dsm-connect-trae-models-expiry-future">{t('row.creditsNoExpiry')}</p>
  }
  return null
}

/** 一个模型行。 */
function ModelRow(props: {
  t: (key: TraePoolSettingsKey, params?: Record<string, unknown>) => string
  model: TraePoolWebModel
  enabled: boolean
  images: boolean
  budget: number | undefined
  disabled: boolean
  onToggleEnabled: (next: boolean) => void
  onToggleImages: (next: boolean) => void
  onBudgetChange: (next: number | undefined) => void
}) {
  const { t, model, enabled, images, budget, disabled, onToggleEnabled, onToggleImages, onBudgetChange } = props
  // 有档位建议才挂 datalist；没有就完全自由输入（`list` 与 `<datalist>` 必须同生同灭）。
  const hasBudgetOptions = model.budgetOptions !== undefined && model.budgetOptions.length > 0

  return (
    <div className="dsm-connect-trae-models-model">
      <div className="dsm-connect-trae-models-model-head">
        <span className="dsm-connect-trae-models-model-name">{model.name}</span>
        {model.multiplier !== undefined && (
          <span className="dsm-connect-trae-models-tag dsm-connect-trae-models-tag-neutral">
            {model.multiplier === 0 ? t('row.modelFree') : t('row.modelCredits', { rate: model.multiplier.toFixed(2) })}
          </span>
        )}
      </div>
      <div className="dsm-connect-trae-models-model-facts">
        <span>{t('row.modelNativeWindow', { native: model.nativeContextWindow })}</span>
        {model.maxOutputTokens !== undefined && (
          <span>{t('row.modelMaxOutput', { count: model.maxOutputTokens })}</span>
        )}
      </div>
      <div className="dsm-connect-trae-models-model-controls">
        <label className="dsm-connect-trae-models-toggle">
          <input
            type="checkbox"
            aria-label={`${t('row.modelEnabled')} ${model.name}`}
            checked={enabled}
            disabled={disabled}
            onChange={event => onToggleEnabled(event.target.checked)}
          />
          <span>{t('row.modelEnabled')}</span>
        </label>
        <label className="dsm-connect-trae-models-toggle">
          <input
            type="checkbox"
            aria-label={`${t('row.modelImages')} ${model.name}`}
            checked={images}
            disabled={disabled}
            onChange={event => onToggleImages(event.target.checked)}
          />
          <span>{t('row.modelImages')}</span>
        </label>
        <label className="dsm-connect-trae-models-budget">
          <span>{t('row.modelBudget')}</span>
          <input
            type="number"
            aria-label={`${t('row.modelBudget')} ${model.name}`}
            // list 与 datalist 必须同生同灭：只挂 list 却渲染不出 datalist 会留下一个
            // 指向不存在 id 的悬空引用（浏览器会静默忽略，但断言与可访问性都说不清）。
            {...hasBudgetOptions ? { list: budgetListId(model.id) } : {}}
            min={MIN_CONTEXT_BUDGET}
            max={model.nativeContextWindow}
            step={1000}
            placeholder={t('row.modelBudgetPlaceholder', { native: model.nativeContextWindow })}
            value={budget === undefined ? '' : String(budget)}
            disabled={disabled}
            onChange={event => {
              const raw = event.target.value.trim()
              if (raw === '') return onBudgetChange(undefined)
              const parsed = Number(raw)
              if (!Number.isFinite(parsed) || parsed <= 0) return
              // 上限是上游宣告的原生窗口：预算可以下调，绝不虚构到窗口之上。
              // 下限与服务端 `parseSelection` 的 1000 对齐，避免「输入 1 token 看着
              // 生效、保存时才被 400 拒绝」。
              onBudgetChange(Math.max(MIN_CONTEXT_BUDGET, Math.min(Math.floor(parsed), model.nativeContextWindow)))
            }}
          />
          {/* 上游真实提供的档位（dev / 500K / Max）。用 datalist 而不是单选按钮：
              档位是「建议值」，用户仍可填任意合法预算（服务端只夹上下界）。 */}
          {hasBudgetOptions && (
            <datalist id={budgetListId(model.id)}>
              {model.budgetOptions!.map(option => <option key={option} value={option} />)}
            </datalist>
          )}
        </label>
      </div>
    </div>
  )
}

/** 对外暴露的 unwrap 由 status-paths 提供；此处仅重导出以免调用方多import一处。 */
export { unwrapVolatileDeep }
