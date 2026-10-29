/**
 * 上下文申报链路测试（问题 1 修复的验收面）。
 *
 * 这条链路是本次事故的根因所在，必须逐环钉死，任何一环回退都会重新打开
 * 「模型正常返回却被判成溢出」的通道：
 *
 *   上游 wire（context_window_tokens.dev / .max）
 *     → parseTraeRemoteModel（max 档必须无条件解析，不能被 max_mode 挡住）
 *     → context-window.ts 档位算术（dev / 500K / Max，去重升序，绝不虚构）
 *     → catalog.visible()（唯一窗口解析点）
 *     → adapter.toPiModel（原样申报给 DSH）
 *
 * 另有第二个输入：configuredMaxTokens（输出保留量）。它参与
 * dsh-compaction-basic 的 `resolveCompactSpec`，给多了会把 pressureBudget
 * 压到负数直接抛 TargetPressureConfigError，所以只在「留够消息预算」时才申报。
 */

import { describe, expect, it } from 'vitest'
import {
  configuredMaxTokensFor,
  safeOutputReservation,
  TRAE_MIN_MESSAGE_BUDGET_TOKENS,
} from '../src/adapter.ts'
import {
  budgetCeiling,
  contextBudgetOptions,
  defaultContextWindow,
  effectiveContextWindow,
  resolveContextBudget,
  TRAE_CONTEXT_BUDGET_MID,
} from '../src/context-window.ts'
import { parseTraeRemoteModel } from '../src/model-metadata.ts'
import { TraeCatalog, type TraeModelInfo } from '../src/catalog.ts'

const model = (over: Partial<TraeModelInfo> & Pick<TraeModelInfo, 'id'>): TraeModelInfo => ({
  name: over.id,
  multimodal: false,
  contextWindow: 200_000,
  ...over,
})

describe('parseTraeRemoteModel：Max 档不受 max_mode 门槛影响', () => {
  const wire = (maxMode: boolean | undefined): Record<string, unknown> => ({
    name: 'deepseek-v4.1-flash',
    display_name: 'DeepSeek-V4.1-Flash',
    multimodal: true,
    ...maxMode === undefined ? {} : { max_mode: maxMode },
    context_window_tokens: { dev: 200_000, max: 1_000_000 },
  })

  it('max_mode=true 时解析出 Max 档', () => {
    expect(parseTraeRemoteModel(wire(true)).maxContextWindow).toBe(1_000_000)
  })

  it('max_mode=false 时**仍然**解析出 Max 档（这正是事故缺陷）', () => {
    const parsed = parseTraeRemoteModel(wire(false))
    // 窗口本身必须照常解析出来——旧实现被 max_mode 挡掉，才把 1M 的模型钉在 200K。
    expect(parsed.maxContextWindow).toBe(1_000_000)
    // maxMode 只是「Max 档是否可计费」的标记，false 时根本不出现，不参与窗口算术。
    expect(parsed.maxMode).toBeUndefined()
  })

  it('max_mode 缺失时仍然解析出 Max 档，且 maxMode 不出现', () => {
    const parsed = parseTraeRemoteModel(wire(undefined))
    expect(parsed.maxContextWindow).toBe(1_000_000)
    expect(parsed.maxMode).toBeUndefined()
  })
})

describe('contextBudgetOptions：只在真实档位间切换', () => {
  it('1M Max → dev / 500K / Max 三档升序', () => {
    expect(contextBudgetOptions({ contextWindow: 200_000, maxContextWindow: 1_000_000 }))
      .toEqual([200_000, TRAE_CONTEXT_BUDGET_MID, 1_000_000])
  })

  it('272K Max（不足 500K）→ 只有 dev 与 Max 两档，不插入不存在的 500K', () => {
    expect(contextBudgetOptions({ contextWindow: 200_000, maxContextWindow: 272_000 }))
      .toEqual([200_000, 272_000])
  })

  it('没有 Max 档 → 只有 dev，绝不虚构更大的窗口', () => {
    expect(contextBudgetOptions({ contextWindow: 200_000 })).toEqual([200_000])
  })

  it('dev 已达 500K → 不重复插入中档', () => {
    expect(contextBudgetOptions({ contextWindow: 500_000, maxContextWindow: 1_000_000 }))
      .toEqual([500_000, 1_000_000])
  })

  it('dev 档被预算压低后，档位列表仍然从真实 dev 起算（不随预算漂移）', () => {
    // devContextWindow 记住原始 dev；contextWindow 已被压到 128K。
    expect(contextBudgetOptions({ contextWindow: 128_000, devContextWindow: 200_000, maxContextWindow: 1_000_000 }))
      .toEqual([200_000, TRAE_CONTEXT_BUDGET_MID, 1_000_000])
  })
})

describe('defaultContextWindow：保守默认，绝不再钉死 dev 档', () => {
  it('1M Max → 默认 500K（事故里的 24~34 万 token 能装下）', () => {
    expect(defaultContextWindow({ contextWindow: 200_000, maxContextWindow: 1_000_000 }))
      .toBe(TRAE_CONTEXT_BUDGET_MID)
  })

  it('272K Max（≤500K）→ 默认直接用 Max，不降级', () => {
    expect(defaultContextWindow({ contextWindow: 200_000, maxContextWindow: 272_000 })).toBe(272_000)
  })

  it('没有 Max → 默认 dev', () => {
    expect(defaultContextWindow({ contextWindow: 200_000 })).toBe(200_000)
  })

  it('完全没有窗口 → 兜底 200K', () => {
    expect(defaultContextWindow({})).toBe(200_000)
  })
})

describe('resolveContextBudget：非法作废，越界夹紧', () => {
  const m = { contextWindow: 200_000, maxContextWindow: 1_000_000 }

  it('合法档位原样返回', () => {
    expect(resolveContextBudget(m, 1_000_000)).toBe(1_000_000)
  })

  it('越界预算夹到 Max，而不是作废（作废会把窗口收回 500K，收窄正是危险方向）', () => {
    expect(resolveContextBudget(m, 9_000_000)).toBe(1_000_000)
  })

  it('非正数 / 非有限 / 非数字一律作废', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(resolveContextBudget(m, bad)).toBeUndefined()
    }
  })

  it('小数向下取整', () => {
    expect(resolveContextBudget(m, 300_000.9)).toBe(300_000)
  })

  it('budgetCeiling 取最宽档', () => {
    expect(budgetCeiling(m)).toBe(1_000_000)
  })

  it('effectiveContextWindow 合并两者', () => {
    expect(effectiveContextWindow(m, 128_000)).toBe(128_000)
    expect(effectiveContextWindow(m, undefined)).toBe(TRAE_CONTEXT_BUDGET_MID)
  })
})

describe('catalog.visible()：申报值的唯一解析点', () => {
  const discovered = model({
    id: 'deepseek-v4.1-flash',
    contextWindow: 200_000,
    maxContextWindow: 1_000_000,
  })

  const catalogWith = (selection = {}): TraeCatalog => {
    const catalog = new TraeCatalog('cn')
    catalog.update([discovered])
    catalog.applySelection(selection)
    return catalog
  }

  it('未设预算 → 申报 500K（旧实现申报 200K，正是事故根因）', () => {
    expect(catalogWith().visible()[0]?.contextWindow).toBe(500_000)
  })

  it('预算 = Max → 申报 1M', () => {
    expect(catalogWith({ contextBudgets: { 'deepseek-v4.1-flash': 1_000_000 } }).visible()[0]?.contextWindow)
      .toBe(1_000_000)
  })

  it('预算 = dev → 回到 200K', () => {
    expect(catalogWith({ contextBudgets: { 'deepseek-v4.1-flash': 200_000 } }).visible()[0]?.contextWindow)
      .toBe(200_000)
  })

  it('预算越界 → 夹到 1M', () => {
    expect(catalogWith({ contextBudgets: { 'deepseek-v4.1-flash': 9_000_000 } }).visible()[0]?.contextWindow)
      .toBe(1_000_000)
  })

  it('all() 与 visible() 申报同一个窗口（卡片展示值与 DSH 实收值必须一致）', () => {
    const catalog = catalogWith({ contextBudgets: { 'deepseek-v4.1-flash': 1_000_000 } })
    expect(catalog.all()[0]?.contextWindow).toBe(catalog.visible()[0]?.contextWindow)
  })
})

describe('configuredMaxTokens：只在留够消息预算时申报输出保留量', () => {
  it('阈值常量为 100K', () => {
    expect(TRAE_MIN_MESSAGE_BUDGET_TOKENS).toBe(100_000)
  })

  it('500K 窗口 + 128K 输出 → 消息预算 372K，足够，申报', () => {
    expect(safeOutputReservation({ maxOutputTokens: 128_000 }, 500_000)).toBe(128_000)
  })

  it('200K 窗口 + 128K 输出 → 消息预算仅 72K，不申报（否则压塌 pressureBudget）', () => {
    expect(safeOutputReservation({ maxOutputTokens: 128_000 }, 200_000)).toBeUndefined()
  })

  it('200K 窗口 + 64K 输出 → 消息预算 136K，足够，申报', () => {
    expect(safeOutputReservation({ maxOutputTokens: 64_000 }, 200_000)).toBe(64_000)
  })

  it('非法 maxOutputTokens 一律不申报', () => {
    for (const bad of [undefined, 0, -1, 1.5, Number.NaN]) {
      expect(safeOutputReservation({ maxOutputTokens: bad }, 1_000_000)).toBeUndefined()
    }
  })

  it('configuredMaxTokensFor 只为合格的模型建条目', () => {
    const map = configuredMaxTokensFor([
      model({ id: 'wide', contextWindow: 500_000, maxOutputTokens: 128_000 }),
      model({ id: 'narrow', contextWindow: 200_000, maxOutputTokens: 128_000 }),
      model({ id: 'no-output', contextWindow: 1_000_000 }),
    ])
    expect([...map.entries()]).toEqual([['wide', 128_000]])
  })
})
