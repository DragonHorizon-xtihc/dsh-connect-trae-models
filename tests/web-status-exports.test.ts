/**
 * t7 验收：全部路由路径与类型从 status-paths.ts 导出，卡片可复用。
 */
import { describe, expect, it } from 'vitest'
import {
  buildTraePoolWebStatus,
  CHECKIN_DEVICE_ALREADY_CLAIMED,
  EXPIRING_SOON_WINDOW_MS,
  parseRegionParam,
  parseSelection,
  registerTraePoolStatusRoute,
  safeMessage,
  unwrapVolatile,
  unwrapVolatileDeep,
  TRAE_POOL_ACCOUNT_TOGGLE_PATH,
  TRAE_POOL_AUTOMATION_RUN_PATH,
  TRAE_POOL_CHECKIN_PATH,
  TRAE_POOL_DEFAULT_REGION,
  TRAE_POOL_MODELS_SAVE_PATH,
  TRAE_POOL_RESET_COOLDOWN_PATH,
  TRAE_POOL_RESCAN_PATH,
  TRAE_POOL_ROUTE_PREFIX,
  TRAE_POOL_STATUS_PATH,
} from '../src/index.ts'
import type {
  TraePoolRegion,
  TraePoolStatusRouteOptions,
  TraePoolWebAccount,
  TraePoolWebAccountToggle,
  TraePoolWebAutomation,
  TraePoolWebAutomationJob,
  TraePoolWebAutomationRunResult,
  TraePoolWebCheckin,
  TraePoolWebCheckinClaim,
  TraePoolWebCreditPack,
  TraePoolWebCredits,
  TraePoolWebModel,
  TraePoolWebModelSelection,
  TraePoolWebStatus,
} from '../src/index.ts'

describe('t7 验收：路由路径与类型导出面', () => {
  it('七条路由常量全部从入口导出，且都在插件前缀下', () => {
    const paths = [
      TRAE_POOL_STATUS_PATH, TRAE_POOL_CHECKIN_PATH, TRAE_POOL_AUTOMATION_RUN_PATH,
      TRAE_POOL_RESCAN_PATH, TRAE_POOL_RESET_COOLDOWN_PATH, TRAE_POOL_MODELS_SAVE_PATH,
      TRAE_POOL_ACCOUNT_TOGGLE_PATH,
    ]
    expect(paths).toHaveLength(7)
    for (const path of paths) expect(path.startsWith(TRAE_POOL_ROUTE_PREFIX)).toBe(true)
    expect(TRAE_POOL_DEFAULT_REGION).toBe('cn')
  })

  it('路由注册与文档组装函数可用', () => {
    expect(typeof registerTraePoolStatusRoute).toBe('function')
    expect(typeof buildTraePoolWebStatus).toBe('function')
    expect(typeof parseRegionParam).toBe('function')
    expect(typeof parseSelection).toBe('function')
    expect(typeof safeMessage).toBe('function')
    expect(typeof unwrapVolatile).toBe('function')
    expect(typeof unwrapVolatileDeep).toBe('function')
    expect(CHECKIN_DEVICE_ALREADY_CLAIMED).toBe(9095)
    expect(EXPIRING_SOON_WINDOW_MS).toBe(3 * 24 * 60 * 60 * 1000)
  })

  it('卡片类型在编译期可用（引用即验证）', () => {
    const region: TraePoolRegion = 'cn'
    const checkin: TraePoolWebCheckin = { enabled: true, checkedIn: false, didCheckedIn: false, credits: 100 }
    const claim: TraePoolWebCheckinClaim = { claimed: true, code: 0 }
    const pack: TraePoolWebCreditPack = { displayDesc: 'x', endTimeMs: 0 }
    const credits: TraePoolWebCredits = { total: 1, consumed: 0, available: 1, packs: [pack] }
    const model: TraePoolWebModel = { id: 'm', name: 'M', enabled: true, supportsImages: false, contextWindow: 1000, nativeContextWindow: 1000 }
    const account: TraePoolWebAccount = { id: 'a', label: 'A', region, cooling: false, disabled: false, rateLimitHits: 0, creditReserve: 0, reserved: false, credits }
    const selection: TraePoolWebModelSelection = { enabledModelIds: ['m'] }
    const job: TraePoolWebAutomationJob = { ok: 0, failed: 0, claimed: 0, credit: 0, deviceSpent: 0 }
    const automation: TraePoolWebAutomation = { enabled: false, running: false, checkinHours: [], jobs: { checkin: job }, earningsToday: {}, runInProgress: false }
    const status: TraePoolWebStatus = { ok: true, region, accounts: [account], cooling: 0, models: [model], selection, distribution: 'priority', shim: { running: false }, automation, creditReserves: {} }
    const toggle: TraePoolWebAccountToggle = { accountId: 'a', disabled: true }
    const run: TraePoolWebAutomationRunResult = { ok: true, started: true }
    const opts: TraePoolStatusRouteOptions = { pool: undefined as never, client: undefined as never, catalogs: undefined as never }
    expect([status.ok, toggle.disabled, run.started, claim.claimed, opts !== undefined]).toEqual([true, true, true, true, true])
  })
})
