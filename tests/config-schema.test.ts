/**
 * 配置 schema 的三态回归（2026-10-29 「模型一个都看不见」事故）。
 *
 * 事故链：schemastery 给 `array` 隐式 `meta.default = []`、给 `dict` 隐式
 * `meta.default = {}`，而 `object` resolver 会对每个 dict 字段递归 resolve
 * 缺失值。于是**从未保存过**的 `modelSelectionCn` 被解析成
 * `{ enabledModelIds: [], imageModelIds: [], contextBudgets: {} }`，
 * `applySelection` 看到的是「用户显式全部停用」，`catalog.visible()` 过滤掉
 * 每一个模型，DSH 的模型选择器于是空的 —— 而 patch 里根本没有那个字段。
 *
 * 因此这三个字段必须显式 `.default(undefined)`：**缺失必须保持缺失**。
 * 本文件用真实的 `Config` schema（不是手写对象）断言这一点；旧测试全部用
 * 普通对象喂 `buildTraePoolWebStatus`，绕过了 schema 解析，所以没抓住它。
 */

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import Schema from '@deepseek-ai/schemastery'
import { Config } from '../src/index.ts'
import { unwrapVolatileDeep } from '../src/status-paths.ts'

/** 按宿主的方式解析一份原始配置，再按插件的方式解包 volatile 引用。 */
function resolveLive(raw: unknown): Record<string, any> {
  const [value] = Schema.resolve(raw as never, Config as never, {})
  return unwrapVolatileDeep(value) as Record<string, any>
}

describe('Config schema 的模型选择三态', () => {
  it('从未保存的分区解析后仍是空对象（不能凭空长出空数组）', () => {
    const live = resolveLive(undefined)

    // 分区对象本身可以存在（object 的隐式默认是 {}），但不能带任何键：
    // 带 `enabledModelIds: []` 就等于「全部停用」。
    expect(live.modelSelectionCn).toEqual({})
    expect(live.modelSelectionGlobal).toEqual({})
    expect(live.modelSelectionCn.enabledModelIds).toBeUndefined()
    expect(live.modelSelectionCn.imageModelIds).toBeUndefined()
    expect(live.modelSelectionCn.contextBudgets).toBeUndefined()
  })

  it('只写了 distribution/automation 的真实 patch 也不会长出启用列表', () => {
    const live = resolveLive({ distribution: 'expiry', automation: { enabled: true, checkinHours: [9] } })

    expect(live.modelSelectionCn).toEqual({})
    expect(live.modelSelectionCn.enabledModelIds).toBeUndefined()
  })

  it('显式空数组必须原样保留（= 用户全部停用）', () => {
    const live = resolveLive({ modelSelectionCn: { enabledModelIds: [] } })

    expect(live.modelSelectionCn.enabledModelIds).toEqual([])
  })

  it('部分列表原样保留，且不影响未写的兄弟字段', () => {
    const live = resolveLive({ modelSelectionCn: { enabledModelIds: ['glm-5.2'] } })

    expect(live.modelSelectionCn.enabledModelIds).toEqual(['glm-5.2'])
    expect(live.modelSelectionCn.imageModelIds).toBeUndefined()
    expect(live.modelSelectionCn.contextBudgets).toBeUndefined()
  })

  it('legacy 平键保留自己的默认语义（空数组 = 从未配置，由宿主折叠）', () => {
    // legacy 字段刻意保留 `.default([])`：applySelection 与 savedSelection 都按
    // 「长度 0 = 未配置」折叠它。这里钉住这个默认值，避免被误改成 undefined 后
    // 与 `ModelSelectionConfig` 的三态判断打架。
    expect(resolveLive(undefined).enabledModelIds).toEqual([])
    expect(resolveLive(undefined).imageModelIds).toEqual([])
  })
})

/**
 * 保存链路的接线不变式（2026-10-29 「全选后保存无效」事故）。
 *
 * `settings.update` 是 `SettingsForms` 的类方法，函数体首行 `await this.write(...)`。
 * cordis 的 reflect handler 取服务时只做 `getTraceable`，**不 bind 方法**，所以
 * `const writer = ctx.settings.update` 一旦被独立调用，`this` 为 undefined，立刻以
 * 「Cannot read properties of undefined (reading 'write')」500 —— 与字段、区域无关，
 * 任何一次保存都写不进去。生产实测复现（POST …/models/save → 500）后修复；
 * 这条断言防止将来为了「顺手简化」把 `.bind` 去掉。
 */
describe('settings 写入的 this 绑定', () => {
  it('settings.update 必须以服务实例为 this 调用（解构后必须 bind）', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

    // 两处写入口（卡片路由 + 自动化账本）都必须 bind。
    expect(source.match(/\.update\?\.bind\(settingsService\)/g)?.length).toBe(2)
    // 绝不能出现裸解构后直接调用：`}).update` 结尾且后面没有 bind。
    expect(source).not.toMatch(/\}\)\.update\s*$/m)
  })
})
