/**
 * 模型目录测试（TraeCatalog + 合并/预算/回退名册）。
 *
 * 覆盖契约（团队计划「关键契约」§目录与 §catalog）：
 * - 回退名册：CN 4 行 / ai 7 行，**每行必须带正整数 contextWindow**——DSH 拒绝
 *   无窗口模型会拖垮整条 provider 路由，这是这条断言存在的唯一理由；
 * - selection：enabled 过滤、image opt-in 与上游 multimodal 并集、contextBudget
 *   上下界（可下调、可抬到上游 Max 档，绝不虚构）；
 * - live/fallback 来源切换与失败降级（一次刷新失败不把健康目录打回静态表）；
 * - 显示名后缀：`name · x0.08`（倍率只画在交给 DSH 的名字上，行上 name 保持纯净）。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  applyModelBudget,
  fallbackModelsFor,
  FALLBACK_TRAE_MODELS,
  FALLBACK_TRAE_MODELS_AI,
  mergeTraeModelSources,
  TRAE_DEFAULT_CONTEXT_WINDOW,
  traeModelDisplayName,
  TraeCatalog,
  type TraeModelInfo,
} from '../src/catalog.ts'

describe('回退名册', () => {
  it('CN 4 行 / ai 7 行，且每一行都有正整数上下文窗口', () => {
    expect(FALLBACK_TRAE_MODELS).toHaveLength(4)
    expect(FALLBACK_TRAE_MODELS_AI).toHaveLength(7)
    for (const model of [...FALLBACK_TRAE_MODELS, ...FALLBACK_TRAE_MODELS_AI]) {
      expect(model.contextWindow, `${model.id} 必须带正整数窗口`).toBeGreaterThan(0)
      expect(Number.isInteger(model.contextWindow)).toBe(true)
      expect(model.id).not.toBe('')
      expect(model.name).not.toBe('')
    }
  })

  it('CN 名册用带 -Official 后缀的 config_name，且不含伪 id', () => {
    expect(FALLBACK_TRAE_MODELS.map(model => model.id)).toEqual([
      'DeepSeek-V4-Flash-Official',
      'DeepSeek-V4-Pro-Official',
      'glm-5.2',
      'kimi-k2.6',
    ])
    // 没有 `auto` 这种伪 id：它在 CN 网关不是可调用的 config_name。
    expect(FALLBACK_TRAE_MODELS.some(model => model.id === 'auto')).toBe(false)
  })

  it('ai 名册保留逐行窗口（gpt-5.4/gpt-5.2 是 272K，其余 200K）', () => {
    const byId = new Map(FALLBACK_TRAE_MODELS_AI.map(model => [model.id, model]))
    expect(byId.get('gpt-5.4')?.contextWindow).toBe(272_000)
    expect(byId.get('gpt-5.2')?.contextWindow).toBe(272_000)
    expect(byId.get('gemini-3.1-pro')?.contextWindow).toBe(200_000)
    // 两个区域名册几乎不重叠：ai 名册不能含 CN 行的 id。
    const cnIds = new Set(FALLBACK_TRAE_MODELS.map(model => model.id))
    expect(FALLBACK_TRAE_MODELS_AI.some(model => cnIds.has(model.id))).toBe(false)
  })

  it('fallbackModelsFor 按区域取册', () => {
    expect(fallbackModelsFor('cn')).toBe(FALLBACK_TRAE_MODELS)
    expect(fallbackModelsFor('ai')).toBe(FALLBACK_TRAE_MODELS_AI)
  })

  it('显式断言每个回退行能通过 selection 白名单（id 唯一）', () => {
    for (const roster of [FALLBACK_TRAE_MODELS, FALLBACK_TRAE_MODELS_AI]) {
      const ids = roster.map(model => model.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})

describe('显示名后缀（倍率）', () => {
  it('有倍率时拼 ` · x0.08`，两位小数', () => {
    expect(traeModelDisplayName({ name: 'GLM-5.2', multiplier: 0.08 })).toBe('GLM-5.2 · x0.08')
    expect(traeModelDisplayName({ name: 'GPT-5.4', multiplier: 1.62 })).toBe('GPT-5.4 · x1.62')
    // 免费模型倍率 0 也是有效值，必须画出来。
    expect(traeModelDisplayName({ name: 'Hy3', multiplier: 0 })).toBe('Hy3 · x0.00')
  })

  it('无倍率时是纯净名（绝不补后缀）', () => {
    expect(traeModelDisplayName({ name: 'Kimi-K2.6' })).toBe('Kimi-K2.6')
  })
})

describe('applyModelBudget 预算上下界', () => {
  const model: TraeModelInfo = { id: 'm', name: 'M', contextWindow: 200_000, maxContextWindow: 1_000_000, supportsImages: false }

  it('可以下调窗口', () => {
    expect(applyModelBudget(model, 128_000).contextWindow).toBe(128_000)
  })

  it('可以抬到上游宣告的 Max 档', () => {
    expect(applyModelBudget(model, 900_000).contextWindow).toBe(900_000)
  })

  it('绝不越过 Max 上限（不虚构窗口）', () => {
    expect(applyModelBudget(model, 5_000_000).contextWindow).toBe(1_000_000)
  })

  it('未宣告 Max 档时上限就是当前窗口', () => {
    const plain: TraeModelInfo = { id: 'p', name: 'P', contextWindow: 200_000, supportsImages: false }
    expect(applyModelBudget(plain, 900_000).contextWindow).toBe(200_000)
    expect(applyModelBudget(plain, 100_000).contextWindow).toBe(100_000)
  })

  it('非法预算原样返回（0 / 负数 / NaN / 未设置）', () => {
    for (const budget of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(applyModelBudget(model, budget)).toBe(model)
    }
  })

  it('小数预算向下取整', () => {
    expect(applyModelBudget(model, 128_000.9).contextWindow).toBe(128_000)
  })
})

describe('mergeTraeModelSources 合并', () => {
  const remote = [
    { id: 'glm-5.2', name: 'GLM-5.2', multimodal: true, contextWindow: 200_000, reasoningSupported: true },
    { id: 'kimi-k2.6', name: 'Kimi-K2.6', multimodal: false, contextWindow: 200_000, reasoningSupported: false },
  ]

  it('两个来源都没报窗口时用兜底窗口（DSH 不接受无窗口模型）', () => {
    const merged = mergeTraeModelSources(
      [{ id: 'mystery', name: 'Mystery', multimodal: false, reasoningSupported: false }],
      [],
    )
    expect(merged[0]?.contextWindow).toBe(TRAE_DEFAULT_CONTEXT_WINDOW)
  })

  it('图像能力不在合并层放行（交给 visible() 的单次决策）', () => {
    const merged = mergeTraeModelSources(remote, [])
    expect(merged.every(model => model.supportsImages === false)).toBe(true)
    expect(merged[0]?.multimodal).toBe(true)
  })

  it('supportedEfforts 只来自远端骨架行（wire 的 reasoning 不参与）', () => {
    // 合并层的唯一职责是把 wire 的 config_name/function/折后倍率/输出上限挂到
    // 远端骨架上。推理档位是远端目录的宣告，wire 名册不覆盖它——否则一个只在
    // wire 里多报了档位的账号会改变别的账号看到的模型能力。
    const bare = mergeTraeModelSources(remote, [{
      id: 'glm-5.2',
      name: 'GLM-5.2',
      maxTokens: 64_000,
      reasoning: { supported: ['low', 'high'], defaultEffort: 'high' },
      function: 'solo_work_remote',
    }])
    expect(bare[0]?.supportedEfforts).toBeUndefined()

    // 远端骨架行自己宣告时才有，且未上报的行不写这个键。
    const withEfforts = mergeTraeModelSources([
      { id: 'glm-5.2', name: 'GLM-5.2', multimodal: false, contextWindow: 200_000, reasoningSupported: true, reasoning: { supported: ['low', 'high'], defaultEffort: 'high' } },
      { id: 'kimi-k2.6', name: 'Kimi-K2.6', multimodal: false, contextWindow: 200_000, reasoningSupported: false },
    ], [])
    expect(withEfforts[0]?.supportedEfforts).toEqual(['low', 'high'])
    expect(withEfforts[1]?.supportedEfforts).toBeUndefined()
  })

  it('wire 的 maxTokens / function / 折后倍率挂到行上', () => {
    const merged = mergeTraeModelSources(remote, [{
      id: 'glm-5.2',
      name: 'GLM-5.2',
      maxTokens: 64_000,
      creditMultiplier: 0.08,
      function: 'solo_work_remote',
    }])
    expect(merged[0]).toMatchObject({
      maxOutputTokens: 64_000,
      multiplier: 0.08,
      wireFunction: 'solo_work_remote',
    })
    // 没有 wire 匹配的行不产生 maxOutputTokens / wireFunction / multiplier。
    expect(merged[1]?.maxOutputTokens).toBeUndefined()
    expect(merged[1]?.wireFunction).toBeUndefined()
    expect(merged[1]?.multiplier).toBeUndefined()
  })

  it('按显示名 join（大小写与空白不敏感）', () => {
    const merged = mergeTraeModelSources(
      [{ id: 'opaque-id', name: '  GLM-5.2 ', multimodal: false, contextWindow: 200_000, reasoningSupported: false }],
      [{ id: 'glm-5.2', name: 'glm-5.2', function: 'solo_work_lite' }],
    )
    // 大小写/空白不敏感命中，但 wire id 与 remote id 不同 → wireConfigName。
    expect(merged[0]).toMatchObject({ id: 'opaque-id', wireConfigName: 'glm-5.2', wireFunction: 'solo_work_lite' })
  })

  it('合并保持 remote 的行顺序（骨架决定名册顺序）', () => {
    const merged = mergeTraeModelSources(remote, [{ id: 'solo-only', name: 'Solo Only', function: 'chat_v3' }])
    expect(merged.map(model => model.id)).toEqual(['glm-5.2', 'kimi-k2.6'])
  })
})

describe('TraeCatalog 基本行为', () => {
  it('构造即播种本区域回退名册（cn）', () => {
    const catalog = new TraeCatalog('cn')
    expect(catalog.current()).toBe(FALLBACK_TRAE_MODELS)
    expect(catalog.currentSource()).toBe('fallback')
    expect(catalog.currentRegion()).toBe('cn')
  })

  it('ai 区域播种 ai 名册（不能用 CN 名册）', () => {
    const catalog = new TraeCatalog('ai')
    expect(catalog.current()).toBe(FALLBACK_TRAE_MODELS_AI)
  })

  it('缺省构造 = cn', () => {
    expect(new TraeCatalog().currentRegion()).toBe('cn')
  })

  it('update 替换目录并通知监听者；空列表被忽略', () => {
    const catalog = new TraeCatalog('cn')
    const listener = vi.fn()
    const unsubscribe = catalog.onChange(listener)

    catalog.update([{ id: 'x', name: 'X', contextWindow: 1000, supportsImages: false }])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(catalog.current().map(model => model.id)).toEqual(['x'])

    // 空目录绝不接受：会瞬间清空用户的模型选择器。
    catalog.update([])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(catalog.current()).toHaveLength(1)

    unsubscribe()
    catalog.update([{ id: 'y', name: 'Y', contextWindow: 1000, supportsImages: false }])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('reset 恢复本区域回退名册', () => {
    const catalog = new TraeCatalog('ai')
    catalog.update([{ id: 'x', name: 'X', contextWindow: 1000, supportsImages: false }])
    catalog.reset()
    expect(catalog.current()).toBe(FALLBACK_TRAE_MODELS_AI)
    expect(catalog.currentSource()).toBe('fallback')
  })

  it('find 在 live 目录里按 id 命中（含 wire 信息）', () => {
    const catalog = new TraeCatalog('cn')
    catalog.update([{ id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000, supportsImages: false, wireConfigName: 'glm-5.2-official', wireFunction: 'solo_work_remote' }])
    expect(catalog.find('glm-5.2')).toMatchObject({ wireFunction: 'solo_work_remote' })
    expect(catalog.find('nope')).toBeUndefined()
  })
})

describe('TraeCatalog selection：enabled / image / contextBudget', () => {
  function seeded(): TraeCatalog {
    const catalog = new TraeCatalog('cn')
    catalog.update([
      { id: 'a', name: 'A', contextWindow: 200_000, maxContextWindow: 1_000_000, supportsImages: false, multiplier: 0.08 },
      { id: 'b', name: 'B', contextWindow: 272_000, supportsImages: false },
      { id: 'c', name: 'C', contextWindow: 200_000, supportsImages: false, multimodal: true },
    ])
    return catalog
  }

  it('无选择 = 全部可见（新安装绝不能给空选择器）', () => {
    const catalog = seeded()
    expect(catalog.visible().map(model => model.id)).toEqual(['a', 'b', 'c'])
  })

  it('enabledModelIds 过滤（空数组 = 什么都不给，是显式选择）', () => {
    const catalog = seeded()
    catalog.applySelection({ enabledModelIds: ['a', 'c'] })
    expect(catalog.visible().map(model => model.id)).toEqual(['a', 'c'])

    catalog.applySelection({ enabledModelIds: [] })
    expect(catalog.visible()).toEqual([])
  })

  it('image opt-in 只影响被点名的行', () => {
    const catalog = seeded()
    catalog.applySelection({ imageModelIds: ['a'] })
    const byId = new Map(catalog.visible().map(model => [model.id, model]))
    expect(byId.get('a')?.supportsImages).toBe(true)
    expect(byId.get('b')?.supportsImages).toBe(false)
  })

  it('上游 multimodal 标志即使没有 opt-in 也放行图片', () => {
    const catalog = seeded()
    const byId = new Map(catalog.visible().map(model => [model.id, model]))
    expect(byId.get('c')?.supportsImages).toBe(true)
    expect(byId.get('a')?.supportsImages).toBe(false)
  })

  it('contextBudgets 逐模型生效，且不越过 Max 档', () => {
    const catalog = seeded()
    catalog.applySelection({ contextBudgets: { a: 500_000, b: 100_000, c: 9_000_000 } })
    const byId = new Map(catalog.visible().map(model => [model.id, model]))
    expect(byId.get('a')?.contextWindow).toBe(500_000)
    expect(byId.get('b')?.contextWindow).toBe(100_000)
    // c 没有声明 Max 档：上限是它自己的 200K。
    expect(byId.get('c')?.contextWindow).toBe(200_000)
  })

  it('visible() 返回副本，改它不影响 current()', () => {
    const catalog = seeded()
    const visible = catalog.visible()
    expect(catalog.current()[1]?.contextWindow).toBe(272_000)
    expect(visible).not.toBe(catalog.current())
  })

  it('applySelection 会通知（adapter 据此重建列表）', () => {
    const catalog = seeded()
    const listener = vi.fn()
    catalog.onChange(listener)
    catalog.applySelection({ enabledModelIds: ['a'] })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(catalog.currentSelection()).toEqual({ enabledModelIds: ['a'] })
  })

  it('selection 与目录更新叠加：update 后仍按同一选择过滤', () => {
    const catalog = seeded()
    catalog.applySelection({ enabledModelIds: ['a', 'b'] })
    catalog.update([
      { id: 'a', name: 'A', contextWindow: 200_000, supportsImages: false },
      { id: 'b', name: 'B', contextWindow: 200_000, supportsImages: false },
      { id: 'd', name: 'D', contextWindow: 200_000, supportsImages: false },
    ])
    expect(catalog.visible().map(model => model.id)).toEqual(['a', 'b'])
  })
})

describe('TraeCatalog live/fallback 来源与失败降级', () => {
  it('updateFromUpstream 切到 live 并记时间戳', () => {
    const catalog = new TraeCatalog('cn')
    catalog.updateFromUpstream([{ id: 'live-1', name: 'Live', contextWindow: 200_000, supportsImages: false }])

    expect(catalog.currentSource()).toBe('live')
    expect(catalog.catalogUpdatedAt()).toBeDefined()
    expect(catalog.lastFetchError()).toBeUndefined()
  })

  it('updateFromUpstream 收到空列表时保留现状并记失败', () => {
    const catalog = new TraeCatalog('cn')
    catalog.updateFromUpstream([{ id: 'live-1', name: 'Live', contextWindow: 200_000, supportsImages: false }])
    catalog.updateFromUpstream([])

    // 空应答是失败：不能把健康目录换成空。
    expect(catalog.current().map(model => model.id)).toEqual(['live-1'])
    expect(catalog.currentSource()).toBe('live')
    expect(catalog.lastFetchError()).toMatch(/no models/)
  })

  it('noteFetchFailure 只记错误，不降级目录（一次刷新失败不改写健康会话）', () => {
    const catalog = new TraeCatalog('cn')
    catalog.updateFromUpstream([{ id: 'live-1', name: 'Live', contextWindow: 200_000, supportsImages: false }])
    const listener = vi.fn()
    catalog.onChange(listener)

    catalog.noteFetchFailure('ECONNRESET')

    expect(catalog.lastFetchError()).toBe('ECONNRESET')
    expect(catalog.currentSource()).toBe('live')
    expect(catalog.current().map(model => model.id)).toEqual(['live-1'])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('成功的刷新清掉上一次的错误', () => {
    const catalog = new TraeCatalog('cn')
    catalog.noteFetchFailure('boom')
    catalog.updateFromUpstream([{ id: 'live-1', name: 'Live', contextWindow: 200_000, supportsImages: false }])

    expect(catalog.lastFetchError()).toBeUndefined()
  })

  it('reset 之后可以再次升到 live', () => {
    const catalog = new TraeCatalog('cn')
    catalog.updateFromUpstream([{ id: 'live-1', name: 'Live', contextWindow: 200_000, supportsImages: false }])
    catalog.reset()
    expect(catalog.currentSource()).toBe('fallback')

    catalog.updateFromUpstream([{ id: 'live-2', name: 'Live 2', contextWindow: 200_000, supportsImages: false }])
    expect(catalog.currentSource()).toBe('live')
    expect(catalog.current().map(model => model.id)).toEqual(['live-2'])
  })
})

describe('TraeCatalog 端到端：合并结果 + 选择 + 显示名', () => {
  it('live 合并结果经 selection 后给出带倍率后缀的 DSH 行', () => {
    const merged = mergeTraeModelSources(
      [
        { id: 'glm-5.2', name: 'GLM-5.2', multimodal: false, contextWindow: 200_000, maxContextWindow: 1_000_000, creditMultiplier: 0.8, reasoningSupported: false },
        { id: 'kimi-k2.6', name: 'Kimi-K2.6', multimodal: true, contextWindow: 200_000, reasoningSupported: false },
      ],
      [
        { id: 'glm-5.2', name: 'GLM-5.2', creditMultiplier: 0.08, function: 'solo_work_remote' },
        { id: 'kimi-k2.6', name: 'Kimi-K2.6', function: 'solo_work_lite' },
      ],
    )
    const catalog = new TraeCatalog('cn')
    catalog.updateFromUpstream(merged)
    catalog.applySelection({ enabledModelIds: ['glm-5.2'], contextBudgets: { 'glm-5.2': 128_000 } })

    const visible = catalog.visible()
    expect(visible).toHaveLength(1)
    const row = visible[0]!
    // 折后倍率进了显示名，窗口被预算压到 128K，wire 目标保留给 shim。
    expect(traeModelDisplayName(row)).toBe('GLM-5.2 · x0.08')
    expect(row.contextWindow).toBe(128_000)
    expect(row.wireFunction).toBe('solo_work_remote')
    // 行上的 name 保持纯净：wire 解析等 join 必须匹配不带后缀的名字。
    expect(row.name).toBe('GLM-5.2')
  })
})
