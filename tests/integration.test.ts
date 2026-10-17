/**
 * 集成闸口（t9）：跨模块装配不变量。
 *
 * 这里只放**跨文件**的契约，单模块行为由各自的测试文件覆盖。每条都对应一个
 * 真实踩过的坑，不是形式化断言。
 */

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { TraeCatalog } from '../src/catalog.ts'
import { buildTraePoolWebStatus, parseSelection } from '../src/web-status.ts'
import { TraeScheduler } from '../src/scheduler.ts'

describe('装配不变量：webServer 是可选服务', () => {
  /**
   * 无头 profile（CLI/测试）没有 `webServer`。裸调
   * `ctx.webServer.register` 会以
   * 「Cannot read properties of undefined (reading 'register')」抛出，
   * 把**整个插件**的 apply 弄崩 —— 不只是卡片，连 provider 都注册不上。
   * 两个参照插件（workbuddy index.ts:894 / connect-trae index.ts:757）都用
   * `ctx.inject(['webServer'], ...)` 包裹，本插件必须一致。
   */
  it('装配层经 ctx.inject([webServer]) 包裹路由注册，不做裸调用', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/ctx\.inject\(\['webServer'\], webCtx => registerTraePoolStatusRoute\(webCtx, \{/)
    // 任何裸调用都会在有 webServer 时重复注册（duplicate route 抛错），
    // 在无 webServer 时崩掉整个 apply。
    expect(source).not.toMatch(/^\s{2}registerTraePoolStatusRoute\(ctx, \{/m)
  })

  it('路由层在被调用时才要求 webServer（装配层负责不调用）', async () => {
    const source = await readFile(new URL('../src/web-status.ts', import.meta.url), 'utf8')
    // 注册函数体在 ctx.effect 内部才触碰 ctx.webServer。
    expect(source).toMatch(/ctx\.effect\(\(\) => \{[\s\S]*?ctx\.webServer\.register/)
  })
})

describe('装配不变量：设置与标识三方一致', () => {
  it('settings ns、provider id 与 cordis id 各自唯一且前缀一致', async () => {
    const index = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    const adapter = await readFile(new URL('../src/adapter.ts', import.meta.url), 'utf8')
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

    expect(index).toMatch(/TRAE_POOL_SETTINGS_NS = 'connect-trae-models'/)
    expect(adapter).toMatch(/TRAE_POOL_PROVIDER = 'connect-trae-models'/)
    expect(adapter).toMatch(/TRAE_GLOBAL_POOL_PROVIDER = 'connect-trae-models-global'/)
    expect(index).toMatch(/export const name = 'llm-connect-trae-models'/)
    expect(patch).toMatch(/id: llm-connect-trae-models/)
  })
})

describe('链路闭合：卡片保存 → 分区 → catalog.visible', () => {
  it('models/save 载荷经校验后施加到对应区域，另一区域不受影响', () => {
    const catalogs = { cn: new TraeCatalog('cn'), ai: new TraeCatalog('ai') }
    const selection = parseSelection({ enabledModelIds: ['glm-5.2'], contextBudgets: { 'glm-5.2': 128_000 } })
    expect(selection).toBeDefined()

    // applyConfigFromSource 的等价动作：分区键 → 该区域 catalog。
    catalogs.cn.applySelection(selection as never)

    expect(catalogs.cn.visible().map(model => model.id)).toEqual(['glm-5.2'])
    expect(catalogs.cn.visible()[0]?.contextWindow).toBe(128_000)
    // ai 名册不被 cn 的分区写覆盖。
    expect(catalogs.ai.visible().length).toBeGreaterThan(1)
  })
})

describe('链路闭合：到期提醒字段三层同名同值', () => {
  it('upstream 快照 → 路由文档，endTimeMs/nearestExpiryMs/expiringSoon 逐一相等', async () => {
    const now = Date.now()
    const snapshot = {
      total: 1200,
      consumed: 350,
      available: 850,
      packs: [{ displayDesc: '签到奖励', entitlementId: 'c1', creditsLimit: 200, consumed: 50, endTimeMs: now + 86_400_000 }],
      nearestExpiryMs: now + 86_400_000,
      expiringSoon: 150,
      expiringSoonWindowMs: 3 * 86_400_000,
    }
    const client = {
      fetchCredits: async () => snapshot,
      fetchCheckinStatus: async () => ({ checkedIn: false, didCheckedIn: false, credits: 100, enabled: true }),
    }
    const pool = {
      list: () => [{
        id: 'a1', label: 'A', region: 'cn',
        credential: { accessToken: 't', userId: 'a1', host: 'h', edition: 'cn', expiresAtMs: 1, source: 'desktop' },
        cooldownUntilMs: 0, modelCooldowns: {}, rateLimitHits: 0,
      }],
      isDisabled: () => false, creditReserveOf: () => 0, isReserved: () => false,
      creditReservesInOrder: () => ({}), lastServedId: () => undefined, currentDistribution: () => 'priority',
    }
    const catalogs = { cn: new TraeCatalog('cn'), ai: new TraeCatalog('ai') }
    const status = await buildTraePoolWebStatus({ pool, client, catalogs } as never, 'cn')

    const credits = status.accounts[0]!.credits!
    expect(credits.nearestExpiryMs).toBe(snapshot.nearestExpiryMs)
    expect(credits.expiringSoon).toBe(snapshot.expiringSoon)
    expect(credits.packs[0]?.endTimeMs).toBe(snapshot.packs[0]!.endTimeMs)
  })
})

describe('链路闭合：签到路由与调度器共用同一组上游语义', () => {
  it('两处都以 CN 区域账号为输入、都按 9095 语义化设备占用', async () => {
    const webStatus = await readFile(new URL('../src/web-status.ts', import.meta.url), 'utf8')
    const scheduler = await readFile(new URL('../src/scheduler.ts', import.meta.url), 'utf8')
    // 9095 在两处都被识别为「设备名额已用」而不是硬失败。
    expect(webStatus).toContain('CHECKIN_DEVICE_ALREADY_CLAIMED = 9095')
    expect(scheduler).toMatch(/claim\.code === 9095/)
    // 调度器只遍历 CN 账号（国际版无 /ug/* 端点族）。
    expect(scheduler).toMatch(/this\.pool\.list\('cn'\)/)
  })

  it('调度器对 ai 区域账号一次调用都不发', async () => {
    const accounts = [
      { id: 'cn1', label: 'CN', region: 'cn', credential: { accessToken: 't', userId: 'cn1', host: 'h', edition: 'cn', expiresAtMs: 1, source: 'desktop' }, cooldownUntilMs: 0, modelCooldowns: {}, rateLimitHits: 0 },
      { id: 'ai1', label: 'AI', region: 'ai', credential: { accessToken: 't', userId: 'ai1', host: 'h', edition: 'sg', expiresAtMs: 1, source: 'desktop' }, cooldownUntilMs: 0, modelCooldowns: {}, rateLimitHits: 0 },
    ]
    const seen: string[] = []
    const client = {
      fetchCheckinStatus: async (request: { credential: { userId: string } }) => {
        seen.push(request.credential.userId)
        return { checkedIn: true, didCheckedIn: false, credits: 100, enabled: true }
      },
      claimCheckin: async () => ({ claimed: true, code: 0, message: 'ok' }),
    }
    const pool = {
      list: (region?: string) => region === undefined ? accounts : accounts.filter(a => a.region === region),
      isDisabled: () => false,
    }
    const scheduler = new TraeScheduler(pool as never, client as never, {
      enabled: true, accountDelayMs: 0, now: () => new Date('2026-10-11T01:00:00.000Z'),
    })
    scheduler.setIdentity({ edition: 'cn', machineId: 'm', deviceId: 'd', platform: 'win32' } as never)

    await scheduler.runAll()

    expect(seen).toEqual(['cn1'])
  })
})
