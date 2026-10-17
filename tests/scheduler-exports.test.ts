/**
 * t6 验收：调度器的契约导出面 + 与真实 TraeUpstreamClient 的接线形状。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AUTOMATION_JOB_KINDS,
  AUTOMATION_TICK_MS,
  dayKey,
  DEFAULT_CHECKIN_HOURS,
  isFireHour,
  slotKey,
  TraeScheduler,
  TraeUpstreamClient,
} from '../src/index.ts'
import type { AutomationJobState, AutomationLedger, AutomationOptions } from '../src/index.ts'

describe('t6 验收：调度器导出面', () => {
  it('契约点名的类型与函数可从入口导入', () => {
    expect(typeof TraeScheduler).toBe('function')
    expect(typeof dayKey).toBe('function')
    expect(typeof slotKey).toBe('function')
    expect(typeof isFireHour).toBe('function')
    expect(AUTOMATION_TICK_MS).toBe(60_000)
    expect([...AUTOMATION_JOB_KINDS]).toEqual(['checkin'])
    expect([...DEFAULT_CHECKIN_HOURS]).toEqual([9])
    // 类型层的引用（编译期验证 AutomationLedger / AutomationJobState / AutomationOptions 可用）
    const state: AutomationJobState = { ok: 0, failed: 0, claimed: 0, credit: 0, deviceSpent: 0 }
    const ledger: AutomationLedger = { date: dayKey(new Date()), accounts: {} }
    const options: AutomationOptions = { enabled: false }
    expect(state.ok).toBe(0)
    expect(ledger.accounts).toEqual({})
    expect(options.enabled).toBe(false)
  })

  it('调度器可直接消费真实的 TraeUpstreamClient（方法形状接线成功）', async () => {
    // 打桩真实客户端的方法：验证调度器调用的方法名与签名确实存在于该类上。
    const client = new TraeUpstreamClient()
    const statusSpy = vi.spyOn(client, 'fetchCheckinStatus').mockResolvedValue(
      { checkedIn: true, didCheckedIn: false, credits: 100, enabled: true },
    )
    const claimSpy = vi.spyOn(client, 'claimCheckin')

    const pool = {
      list: (region?: string) => region === 'cn'
        ? [{ id: 'a1', label: 'acc', credential: { userId: 'u1', accessToken: 't', host: 'https://api.trae.cn', edition: 'cn', expiresAtMs: 0, source: 'desktop' }, region: 'cn' }]
        : [],
      isDisabled: () => false,
    }
    const scheduler = new TraeScheduler(pool as never, client, { enabled: true, accountDelayMs: 0 })
    scheduler.setIdentity({ edition: 'cn', machineId: 'm', deviceId: 'dev-1', platform: 'win32' } as never)

    await scheduler.runAll()

    expect(statusSpy).toHaveBeenCalledTimes(1)
    expect(statusSpy.mock.calls[0]![1]).toBe('dev-1')
    // checked_in=true → 不发 claim（幂等守卫）。
    expect(claimSpy).not.toHaveBeenCalled()
    expect(scheduler.status().jobs.checkin.ok).toBe(1)
  })
})
