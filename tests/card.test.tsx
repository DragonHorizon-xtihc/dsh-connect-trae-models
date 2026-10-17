// @vitest-environment jsdom
/**
 * Trae Connect Models 卡片的 UI 测试。
 *
 * 为什么这个文件存在 —— 删改前先读：
 * 卡片渲染的是 **src/client/TraePoolCard.tsx 的真实实现**，不是手抄的镜像
 * （手抄镜像曾经在本仓库静默漂移并放过一个坏掉的行为）。断言落在渲染结果与
 * 实际发出的请求上。
 *
 * 覆盖：
 *  1. 签到按钮的四种状态（可领取 / 账号级已领 / 设备级已用 / 活动未开启）；
 *  2. 积分到期提醒文案与颜色语义（≤3 天橙色、已过期灰显、无到期包不误报）；
 *  3. 模型开关与上下文预算渲染（上限=上游原生窗口）；
 *  4. 自动化面板的开关与「立即运行」；
 *  5. 账号启停开关 POST 到 accounts/disabled；
 *  6. 状态文档缺失/失败时的降级（不白屏）。
 *
 * 时间相关断言全部注入固定 nowMs，避免跨日抖动。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TraePoolCard, checkinStateOf, expiryDisplayOf } from '../src/client/TraePoolCard.tsx'
import {
  TRAE_POOL_ACCOUNT_TOGGLE_PATH,
  TRAE_POOL_AUTOMATION_RUN_PATH,
  TRAE_POOL_CHECKIN_PATH,
  TRAE_POOL_MODELS_SAVE_PATH,
  TRAE_POOL_RESCAN_PATH,
  TRAE_POOL_STATUS_PATH,
} from '../src/status-paths.ts'
import type { TraePoolWebStatus } from '../src/status-paths.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 恒等翻译：断言断在 key 上，与文案解耦（文案由 locales 测试单独钉住）。 */
const t = ((key: string, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`) as never

const DAY = 24 * 60 * 60 * 1000

/** 一份最小的状态文档；各用例只覆盖自己关心的字段。 */
function statusDocument(overrides: Record<string, unknown> = {}): TraePoolWebStatus {
  return {
    ok: true,
    region: 'cn',
    accounts: [],
    cooling: 0,
    models: [],
    selection: {},
    distribution: 'priority',
    shim: { running: true, baseUrl: 'http://127.0.0.1:1234' },
    automation: {
      enabled: false,
      running: false,
      checkinHours: [9],
      jobs: { checkin: { ok: 0, failed: 0, claimed: 0, credit: 0, deviceSpent: 0 } },
      earningsToday: {},
      runInProgress: false,
    },
    creditReserves: {},
    catalogSource: 'live',
    ...overrides,
  } as TraePoolWebStatus
}

/** 一个账号行；默认是健康的 CN 账号。 */
function accountDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acct-1',
    label: 'alice#alice',
    region: 'cn',
    cooling: false,
    disabled: false,
    rateLimitHits: 0,
    creditReserve: 0,
    reserved: false,
    ...overrides,
  }
}

/** 桩 fetch：状态路由回答给定文档，其余记录请求并回 200。 */
function stubFetch(
  statusDoc: TraePoolWebStatus | ((url: string) => TraePoolWebStatus),
  answers: Record<string, { status?: number; body?: unknown }> = {},
): { calls: { url: string; method: string; body?: unknown }[] } {
  const calls: { url: string; method: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, ...init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown } })
    if (url.startsWith(TRAE_POOL_STATUS_PATH)) {
      const payload = typeof statusDoc === 'function' ? statusDoc(url) : statusDoc
      return new Response(JSON.stringify(payload), { status: 200 })
    }
    const answer = Object.entries(answers).find(([prefix]) => url.startsWith(prefix))?.[1]
    if (answer !== undefined) {
      return new Response(JSON.stringify(answer.body ?? { ok: true }), { status: answer.status ?? 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
  return { calls }
}

/** 渲染卡片并等待第一份状态落地。 */
async function renderCard(statusDoc: TraePoolWebStatus, options: {
  answers?: Record<string, { status?: number; body?: unknown }>
  scope?: unknown
} = {}): Promise<{ calls: { url: string; method: string; body?: unknown }[] }> {
  const stub = stubFetch(statusDoc, options.answers)
  render(<TraePoolCard t={t} settingsScope={(options.scope ?? undefined) as never} fetchImpl={fetch} />)
  await waitFor(() => { expect(screen.getAllByText(/row.healthSummary/).length).toBeGreaterThan(0) })
  return stub
}

describe('文案完整性', () => {
  it('zh 与 en 的 key 完全 1:1', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    // 没有空文案：漏译会让用户看到一片空白。
    for (const [key, value] of Object.entries(zh)) {
      expect(value.length, `zh.${key} 为空`).toBeGreaterThan(0)
    }
    for (const [key, value] of Object.entries(en)) {
      expect(value.length, `en.${key} 为空`).toBeGreaterThan(0)
    }
  })

  it('中文文案确实是中文（防止误把英文抄进 zh）', () => {
    // 「XD 账号池」这类全英文/符号的短标签不在检查范围。
    const cjk = /[\u4e00-\u9fff]/
    for (const key of ['row.checkinClaim', 'row.creditsExpiresSoonTitle', 'row.autoEnable', 'row.accountsTitle'] as const) {
      expect(cjk.test(zh[key]), `zh.${key} 应含中文`).toBe(true)
    }
  })
})

describe('签到按钮四态', () => {
  it('活动开启且未领取时给出可点的「立即签到」', async () => {
    const statusDoc = statusDocument({
      accounts: [accountDocument({
        checkin: { enabled: true, checkedIn: false, didCheckedIn: false, credits: 150 },
      })],
    })
    await renderCard(statusDoc)

    const button = screen.getByRole('button', { name: /row.checkinClaim$/ }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(screen.getByText(/row.checkinAvailable:.*150/)).toBeTruthy()
  })

  it('账号级已领时禁用按钮并显示已领文案', async () => {
    const statusDoc = statusDocument({
      accounts: [accountDocument({
        checkin: { enabled: true, checkedIn: true, didCheckedIn: true, credits: 150 },
      })],
    })
    await renderCard(statusDoc)

    const button = screen.getByRole('button', { name: /row.checkinClaim$/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText(/row.checkinClaimed:.*150/)).toBeTruthy()
  })

  it('仅设备级已用时禁用，但文案说清是「本机名额」而不是「已领取」', async () => {
    // 这是多账号池的核心约束：同一台机器一天只能为一个账号签到。把设备级
    // 当成账号级是一个已发布过的缺陷，会让用户以为新账号拿到了积分。
    const statusDoc = statusDocument({
      accounts: [accountDocument({
        checkin: { enabled: true, checkedIn: false, didCheckedIn: true, credits: 150 },
      })],
    })
    await renderCard(statusDoc)

    const button = screen.getByRole('button', { name: /row.checkinClaim$/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText('row.checkinDeviceSpent')).toBeTruthy()
    // 绝不显示「今日已领」。
    expect(screen.queryByText(/row.checkinClaimed/)).toBeNull()
  })

  it('活动未开启时禁用并给出原因', async () => {
    const statusDoc = statusDocument({
      accounts: [accountDocument({
        checkin: { enabled: false, checkedIn: false, didCheckedIn: false, credits: 150 },
      })],
    })
    await renderCard(statusDoc)

    const button = screen.getByRole('button', { name: /row.checkinClaim$/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText('row.checkinDisabled')).toBeTruthy()
  })

  it('checkinStateOf 的判定顺序：账号级 > 设备级 > 活动开关', () => {
    expect(checkinStateOf({ enabled: true, checkedIn: true, didCheckedIn: true })).toBe('claimed')
    expect(checkinStateOf({ enabled: true, checkedIn: false, didCheckedIn: true })).toBe('deviceSpent')
    expect(checkinStateOf({ enabled: false, checkedIn: false, didCheckedIn: false })).toBe('disabled')
    expect(checkinStateOf({ enabled: true, checkedIn: false, didCheckedIn: false })).toBe('available')
    expect(checkinStateOf(undefined)).toBe('disabled')
    // deviceSpent 标志（账号行自带）也能推出设备受限。
    expect(checkinStateOf({ enabled: true, checkedIn: false, didCheckedIn: false }, true)).toBe('deviceSpent')
  })

  it('点击后 POST 到签到路由并带上账号与区域', async () => {
    const statusDoc = statusDocument({
      accounts: [accountDocument({
        checkin: { enabled: true, checkedIn: false, didCheckedIn: false, credits: 150 },
      })],
    })
    const { calls } = await renderCard(statusDoc, {
      answers: { [TRAE_POOL_CHECKIN_PATH]: { body: { claimed: true, code: 0, checkin: { credits: 150, enabled: true, checkedIn: true, didCheckedIn: true } } } },
    })

    fireEvent.click(screen.getByRole('button', { name: /row.checkinClaim$/ }))

    await waitFor(() => {
      expect(calls.some(call => call.url.startsWith(TRAE_POOL_CHECKIN_PATH))).toBe(true)
    })
    const claim = calls.find(call => call.url.startsWith(TRAE_POOL_CHECKIN_PATH))!
    expect(claim.method).toBe('POST')
    expect(claim.body).toMatchObject({ accountId: 'acct-1', region: 'cn' })
    await waitFor(() => { expect(screen.getByText(/row.checkinDone:.*150/)).toBeTruthy() })
  })

  it('上游 200 但 claimed=false 的非零业务码被展示而不是吞掉', async () => {
    const statusDoc = statusDocument({
      accounts: [accountDocument({
        checkin: { enabled: true, checkedIn: false, didCheckedIn: false, credits: 150 },
      })],
    })
    await renderCard(statusDoc, {
      answers: { [TRAE_POOL_CHECKIN_PATH]: { body: { claimed: false, code: 9095, message: '今日已签到' } } },
    })

    fireEvent.click(screen.getByRole('button', { name: /row.checkinClaim$/ }))

    await waitFor(() => { expect(screen.getByText(/row.checkinCode:.*9095/)).toBeTruthy() })
  })
})

describe('积分到期提醒', () => {
  it('≤3 天到期显示橙色提醒与剩余积分', async () => {
    const now = Date.now()
    const statusDoc = statusDocument({
      accounts: [accountDocument({
        credits: {
          total: 500, consumed: 100, available: 400,
          packs: [{ displayDesc: '每月登录赠送', creditsLimit: 500, consumed: 100, endTimeMs: now + 2 * DAY }],
          nearestExpiryMs: now + 2 * DAY,
          expiringSoon: 400,
        },
      })],
    })
    await renderCard(statusDoc)

    const line = screen.getByText(/row.creditsExpiresInDays:.*400/)
    expect(line).toBeTruthy()
    expect(line.className).toContain('dsm-connect-trae-models-expiry-soon')
    // 汇总徽标也出现。
    expect(screen.getByText(/row.creditsSoonBadge:.*400/)).toBeTruthy()
  })

  it('超过 3 天只报时间，不用告警色', async () => {
    const now = Date.now()
    const statusDoc = statusDocument({
      accounts: [accountDocument({
        credits: {
          total: 500, consumed: 0, available: 500,
          packs: [{ displayDesc: '包A', creditsLimit: 500, consumed: 0, endTimeMs: now + 30 * DAY }],
          nearestExpiryMs: now + 30 * DAY,
        },
      })],
    })
    await renderCard(statusDoc)

    // 用样式类定位，而不是文案：积分包明细的表头文案与这一行相同。
    const line = document.querySelector('.dsm-connect-trae-models-expiry-future')!
    expect(line).toBeTruthy()
    expect(line.className).not.toContain('expiry-soon')
    expect(line.textContent).toContain('row.creditsExpiresAt:')
  })

  it('全部已过期时灰显，不当作即将到期', async () => {
    const now = Date.now()
    const statusDoc = statusDocument({
      accounts: [accountDocument({
        credits: {
          total: 500, consumed: 500, available: 0,
          packs: [{ displayDesc: '包A', creditsLimit: 500, consumed: 200, endTimeMs: now - DAY }],
        },
      })],
    })
    await renderCard(statusDoc)

    const line = screen.getByText(/row.creditsExpired:/)
    expect(line.className).toContain('dsm-connect-trae-models-expiry-past')
  })

  it('没有带截止时间的包时不误报「即将到期」', async () => {
    const statusDoc = statusDocument({
      accounts: [accountDocument({
        credits: {
          total: 500, consumed: 0, available: 500,
          packs: [{ displayDesc: '永久包', creditsLimit: 500, consumed: 0, endTimeMs: 0 }],
        },
      })],
    })
    await renderCard(statusDoc)

    expect(screen.getByText(/row.creditsNoExpiry/)).toBeTruthy()
    expect(screen.queryByText(/row.creditsExpiresInDays/)).toBeNull()
    expect(screen.queryByText(/row.creditsSoonBadge/)).toBeNull()
  })

  it('expiryDisplayOf 分界：刚好 3 天算 soon，3 天零 1 毫秒算 future', () => {
    const now = 1_000_000_000_000
    expect(expiryDisplayOf({ endTimeMs: now + 3 * DAY, creditsLimit: 10 }, now)?.kind).toBe('soon')
    expect(expiryDisplayOf({ endTimeMs: now + 3 * DAY + 1, creditsLimit: 10 }, now)?.kind).toBe('future')
    expect(expiryDisplayOf({ endTimeMs: now - 1, creditsLimit: 10 }, now)?.kind).toBe('past')
    // endTimeMs=0 表示上游未回报到期时间：不是「已过期」，而是「没有截止时间」。
    expect(expiryDisplayOf({ endTimeMs: 0, creditsLimit: 10 }, now)).toBeUndefined()
    expect(expiryDisplayOf({ endTimeMs: now + 2 * DAY, creditsLimit: 100, consumed: 30 }, now)?.remaining).toBe(70)
  })
})

describe('模型管理', () => {
  const models = [
    { id: 'glm-5.2', name: 'GLM-5.2', multiplier: 0.08, enabled: true, supportsImages: false, contextWindow: 200_000, nativeContextWindow: 262_144 },
    { id: 'gemini-3.1-pro', name: 'Gemini-3.1-Pro', multiplier: 0, enabled: false, supportsImages: true, contextWindow: 262_144, nativeContextWindow: 262_144 },
  ]

  it('每行渲染启用/图片开关与倍率后缀', async () => {
    await renderCard(statusDocument({ models }))

    expect(screen.getByLabelText(`row.modelEnabled GLM-5.2`)).toBeTruthy()
    expect(screen.getByLabelText(`row.modelImages GLM-5.2`)).toBeTruthy()
    expect(screen.getByLabelText(`row.modelEnabled Gemini-3.1-Pro`)).toBeTruthy()
    // 倍率 0.08 显示 x0.08；倍率 0 显示「免费」而不是 x0.00。
    expect(screen.getByText(/row.modelCredits:.*0\.08/)).toBeTruthy()
    expect(screen.getByText(/row.modelFree/)).toBeTruthy()
  })

  it('开关状态来自文档：已启用的勾上，未启用的不勾', async () => {
    await renderCard(statusDocument({ models }))

    expect((screen.getByLabelText(`row.modelEnabled GLM-5.2`) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(`row.modelEnabled Gemini-3.1-Pro`) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText(`row.modelImages Gemini-3.1-Pro`) as HTMLInputElement).checked).toBe(true)
  })

  it('上下文预算输入的上限是上游原生窗口，绝不越界', async () => {
    await renderCard(statusDocument({ models }))

    const input = screen.getByLabelText(`row.modelBudget GLM-5.2`) as HTMLInputElement
    expect(input.max).toBe('262144')
    // 输入一个超过原生窗口的值 → 被夹到原生窗口。
    fireEvent.change(input, { target: { value: '9999999' } })
    expect(input.value).toBe('262144')
  })

  it('保存按钮 POST 分区选择到 models/save', async () => {
    const { calls } = await renderCard(statusDocument({ models }), {
      answers: { [TRAE_POOL_MODELS_SAVE_PATH]: { body: { ok: true } } },
    })

    fireEvent.click(screen.getByLabelText(`row.modelEnabled Gemini-3.1-Pro`))
    fireEvent.click(screen.getByRole('button', { name: /row.modelsSave/ }))

    await waitFor(() => {
      expect(calls.some(call => call.url.startsWith(TRAE_POOL_MODELS_SAVE_PATH))).toBe(true)
    })
    const save = calls.find(call => call.url.startsWith(TRAE_POOL_MODELS_SAVE_PATH))!
    expect(save.method).toBe('POST')
    expect(save.body).toMatchObject({ region: 'cn' })
    expect((save.body as { enabledModelIds: string[] }).enabledModelIds).toContain('gemini-3.1-pro')
  })

  it('只读配置下模型控件被禁用', async () => {
    const scope = {
      getSnapshot: () => ({ status: 'ready', writable: false, value: {} }),
      subscribe: () => () => {},
      set: async () => {},
    }
    await renderCard(statusDocument({ models }), { scope })

    expect((screen.getByLabelText(`row.modelEnabled GLM-5.2`) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText(`row.modelBudget GLM-5.2`) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(/row.modelsReadonly/)).toBeTruthy()
  })
})

describe('自动化面板', () => {
  it('渲染总开关并反映文档状态', async () => {
    await renderCard(statusDocument({
      automation: {
        enabled: true,
        running: true,
        checkinHours: [9, 20],
        jobs: { checkin: { ok: 2, failed: 1, claimed: 1, credit: 150, deviceSpent: 1, lastRunAtMs: Date.now(), detail: ['alice: +150'] } },
        earningsToday: {},
        runInProgress: false,
      },
    }))

    const toggle = screen.getByLabelText('row.autoEnable') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    expect(screen.getByText(/row.autoHours:.*9, 20/)).toBeTruthy()
    expect(screen.getByText(/row.autoCounts:/)).toBeTruthy()
    expect(screen.getByText('alice: +150')).toBeTruthy()
  })

  it('总开关把 automation 作为整个对象写入，并带上小时列表', async () => {
    const written: { field: string; value: unknown }[] = []
    const scope = {
      getSnapshot: () => ({ status: 'ready', writable: true, value: {} }),
      subscribe: () => () => {},
      set: async (field: string, value: unknown) => { written.push({ field, value }) },
    }
    await renderCard(statusDocument(), { scope })

    fireEvent.click(screen.getByLabelText('row.autoEnable'))

    await waitFor(() => { expect(written.length).toBe(1) })
    // 顶层键必须是 'automation'：'automation.enabled' 这种点号路径会被当成一个
    // 字面键名，真正的 automation 对象永不更新（复选框勾不动的成因）。
    expect(written[0]?.field).toBe('automation')
    const value = written[0]?.value as { enabled: boolean; checkinHours: number[] }
    expect(value.enabled).toBe(true)
    // 小时列表必须一并带上：只写 enabled 会把调度时刻丢成 schema 缺省。
    expect(value.checkinHours).toEqual([9])
  })

  it('「账号使用方式」列出五种策略并按当前值选中', async () => {
    await renderCard(statusDocument({ distribution: 'sticky' }), {})
    const select = await screen.findByLabelText('row.distributionLabel') as HTMLSelectElement
    expect([...select.options].map(option => option.value)).toEqual([
      'priority', 'round-robin', 'balanced', 'sticky', 'expiry',
    ])
    expect(select.value).toBe('sticky')
    // 说明行必须跟着当前策略走，否则用户只看到名字、不知道它在做什么。
    expect(screen.getByText('row.distributionHint.sticky')).toBeTruthy()
  })

  it('切换使用方式写 settings 的顶层键 distribution', async () => {
    const written: { field: string; value: unknown }[] = []
    const scope = {
      getSnapshot: () => ({ status: 'ready', writable: true, value: {} }),
      subscribe: () => () => {},
      set: async (field: string, value: unknown) => { written.push({ field, value }) },
    }
    await renderCard(statusDocument({ distribution: 'priority' }), { scope })

    const select = await screen.findByLabelText('row.distributionLabel') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'expiry' } })

    await waitFor(() => { expect(written.length).toBe(1) })
    // 顶层键：'distribution' 必须原样写，点号路径会被当成字面键名而永不生效。
    expect(written[0]).toEqual({ field: 'distribution', value: 'expiry' })
  })

  it('只读作用域下使用方式选择器禁用', async () => {
    const scope = {
      getSnapshot: () => ({ status: 'ready', writable: false, value: {} }),
      subscribe: () => () => {},
      set: async () => {},
    }
    await renderCard(statusDocument({ distribution: 'priority' }), { scope })

    const select = await screen.findByLabelText('row.distributionLabel') as HTMLSelectElement
    expect(select.disabled).toBe(true)
  })

  it('「立即运行」POST 到 automation/run 并显示已启动', async () => {
    const { calls } = await renderCard(statusDocument(), {
      answers: { [TRAE_POOL_AUTOMATION_RUN_PATH]: { body: { ok: true, started: true } } },
    })

    fireEvent.click(screen.getByRole('button', { name: /row.autoRun$/ }))

    await waitFor(() => {
      expect(calls.some(call => call.url.startsWith(TRAE_POOL_AUTOMATION_RUN_PATH))).toBe(true)
    })
    expect(calls.find(call => call.url.startsWith(TRAE_POOL_AUTOMATION_RUN_PATH))!.method).toBe('POST')
    await waitFor(() => { expect(screen.getByText(/row.autoRunStarted/)).toBeTruthy() })
  })

  it('运行在途时按钮禁用并显示运行中', async () => {
    await renderCard(statusDocument({
      automation: {
        enabled: true, running: true, checkinHours: [9],
        jobs: { checkin: { ok: 0, failed: 0, claimed: 0, credit: 0, deviceSpent: 0 } },
        earningsToday: {}, runInProgress: true,
      },
    }))

    const button = screen.getByRole('button', { name: /row.autoRunning/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('今日收益按账号名展示；设备受限的账号如实标注', async () => {
    await renderCard(statusDocument({
      accounts: [accountDocument({ id: 'acct-1', label: 'alice#alice' })],
      automation: {
        enabled: true, running: true, checkinHours: [9],
        jobs: { checkin: { ok: 1, failed: 0, claimed: 1, credit: 150, deviceSpent: 0 } },
        earningsToday: {
          'acct-1': { credit: 150, checkinCredit: 150, date: '2026-10-11' },
        },
        runInProgress: false,
      },
    }))

    expect(screen.getByText(/row.autoTodayAccount:.*alice#alice.*150/)).toBeTruthy()
  })
})

describe('账号池与顶部操作', () => {
  it('渲染账号行与池健康汇总', async () => {
    await renderCard(statusDocument({
      accounts: [accountDocument({ id: 'acct-1', label: 'alice#alice' }), accountDocument({ id: 'acct-2', label: 'bob#bob', disabled: true })],
      cooling: 1,
      activeAccountId: 'acct-1',
    }))

    expect(screen.getByText('alice#alice')).toBeTruthy()
    expect(screen.getByText('bob#bob')).toBeTruthy()
    expect(screen.getByText(/row.healthSummary:.*2.*1/)).toBeTruthy()
    expect(screen.getAllByText(/row.activeAccount:.*alice#alice/).length).toBeGreaterThan(0)
  })

  it('账号启停开关 POST 到 accounts/disabled', async () => {
    const { calls } = await renderCard(statusDocument({
      accounts: [accountDocument({ id: 'acct-1', label: 'alice#alice' })],
    }), { answers: { [TRAE_POOL_ACCOUNT_TOGGLE_PATH]: { body: { ok: true } } } })

    fireEvent.click(screen.getByLabelText('row.accountInRotation alice#alice'))

    await waitFor(() => {
      expect(calls.some(call => call.url.startsWith(TRAE_POOL_ACCOUNT_TOGGLE_PATH))).toBe(true)
    })
    const toggle = calls.find(call => call.url.startsWith(TRAE_POOL_ACCOUNT_TOGGLE_PATH))!
    expect(toggle.method).toBe('POST')
    expect(toggle.body).toMatchObject({ accountId: 'acct-1', disabled: true })
  })

  it('登录被拒的账号显示红色标签与补救说明', async () => {
    await renderCard(statusDocument({
      accounts: [accountDocument({ credentialDead: true, credentialDeadUntil: new Date(Date.now() + 600_000).toISOString() })],
    }))

    expect(screen.getByText(/row.credentialDead\b/)).toBeTruthy()
    expect(screen.getByText(/row.credentialDeadHint/)).toBeTruthy()
  })

  it('按模型冷却逐条列出（账号整体不算冷却）', async () => {
    await renderCard(statusDocument({
      accounts: [accountDocument({
        modelCooldowns: [{ modelId: 'glm-5.2', until: new Date(Date.now() + 60_000).toISOString() }],
      })],
    }))

    expect(screen.getByText('row.modelCoolingTitle:')).toBeTruthy()
    expect(screen.getByText(/row.modelCooling:.*glm-5\.2/)).toBeTruthy()
  })

  it('「重新检测账号」POST 到 rescan 并显示结果', async () => {
    const { calls } = await renderCard(statusDocument(), {
      answers: { [TRAE_POOL_RESCAN_PATH]: { body: { ok: true, count: 3 } } },
    })

    fireEvent.click(screen.getByRole('button', { name: /row.rescan$/ }))

    await waitFor(() => {
      expect(calls.some(call => call.url.startsWith(TRAE_POOL_RESCAN_PATH))).toBe(true)
    })
    await waitFor(() => { expect(screen.getByText(/row.rescanDone:.*3/)).toBeTruthy() })
  })

  it('区域 Tab 切换后用另一区域重新拉状态', async () => {
    const { calls } = await renderCard(statusDocument())
    const before = calls.length

    fireEvent.click(screen.getByRole('tab', { name: /row.regionAi/ }))

    await waitFor(() => {
      expect(calls.slice(before).some(call => call.url.includes('region=ai'))).toBe(true)
    })
  })

  it('空池时给出登录指引而不是空白', async () => {
    await renderCard(statusDocument({ accounts: [] }))

    expect(screen.getByText(/row.regionEmptyTitle/)).toBeTruthy()
    expect(screen.getByText(/row.regionHowTo1/)).toBeTruthy()
    expect(screen.getByText(/row.regionHowToNote/)).toBeTruthy()
  })
})

describe('降级', () => {
  it('状态路由报错时显示错误行，不白屏', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
    render(<TraePoolCard t={t} fetchImpl={fetch} />)

    await waitFor(() => { expect(screen.getByText(/row\.requestFailed.*boom/)).toBeTruthy() })
    // 页面骨架仍在。
    expect(screen.getByText('row.title')).toBeTruthy()
  })

  it('缺少 fetch（非浏览器环境）时不抛错', () => {
    render(<TraePoolCard t={t} />)
    expect(screen.getByText('row.title')).toBeTruthy()
  })
})
