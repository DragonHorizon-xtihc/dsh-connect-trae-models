// @vitest-environment jsdom
/**
 * 对话栏积分读数 + 切换用户面板的 UI 测试。
 *
 * 覆盖：
 *  1. 非本插件的 provider 渲染空（不能在别的模型旁边显示 Trae 余额）；
 *  2. 触发器显示被钉住账号的可用积分；
 *  3. 面板只列出**参与轮转**的账号（被停用的不出现）；
 *  4. 点某个账号 POST 到 accounts/select，随后重新读状态文档；
 *  5. 读失败保留上次数值而不是清空；
 *  6. 积分与面板行的纯函数（格式、空文档、区域映射）。
 *
 * 时间相关断言全部注入固定 nowMs，避免跨日抖动。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ComposerCredits, COMPOSER_PROVIDERS, formatCredits, toComposerRows } from '../src/client/ComposerCredits.tsx'
import { ComposerCreditsGate, selectedProviderOf, composerRegionOf } from '../src/client/ComposerCreditsGate.tsx'
import type { TraePoolWebStatus } from '../src/status-paths.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 恒等翻译：断言断在 key 上，与文案解耦。 */
const t = ((key: string) => key) as never

function statusDocument(overrides: Record<string, unknown> = {}): TraePoolWebStatus {
  return {
    ok: true,
    region: 'cn',
    accounts: [],
    cooling: 0,
    models: [],
    selection: {},
    distribution: 'priority',
    shim: { running: true },
    automation: {
      enabled: false,
      running: false,
      checkinHours: [9],
      jobs: {
        checkin: { ok: 0, failed: 0, credit: 0, claimed: 0, detail: [] },
      },
      earningsToday: {},
      runInProgress: false,
    },
    creditReserves: {},
    ...overrides,
  } as unknown as TraePoolWebStatus
}

function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    label: 'alice',
    region: 'cn',
    cooling: false,
    disabled: false,
    rateLimitHits: 0,
    creditReserve: 0,
    reserved: false,
    ...overrides,
  }
}

/** 让 fetch 返回一份状态文档，并记录调用过的 URL。 */
function stubStatus(document: TraePoolWebStatus | (() => unknown)): string[] {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input)
    urls.push(init?.method === 'POST' ? `${init.method} ${url} ${String(init.body)}` : url)
    const value = typeof document === 'function' ? (document as () => unknown)() : document
    return {
      ok: true,
      status: 200,
      json: async () => value,
    } as unknown as Response
  }))
  return urls
}

describe('composer 纯函数', () => {
  it('provider id 映射到区域，其它 provider 为 undefined', () => {
    expect(COMPOSER_PROVIDERS['connect-trae-models']).toBe('cn')
    expect(COMPOSER_PROVIDERS['connect-trae-models-global']).toBe('ai')
    expect(COMPOSER_PROVIDERS['deepseek']).toBeUndefined()
  })

  it('积分格式化：整数不带小数，小数保留两位并去尾零', () => {
    expect(formatCredits(0)).toBe('0')
    expect(formatCredits(1200)).toBe('1200')
    expect(formatCredits(1620.5)).toBe('1620.5')
    expect(formatCredits(1200.25)).toBe('1200.25')
    expect(formatCredits(undefined)).toBe('—')
  })

  it('面板只列出参与轮转的账号，并标出被钉选的那个', () => {
    const rows = toComposerRows(statusDocument({
      accounts: [
        accountRow({ id: 'a1', label: 'alice', credits: { total: 100, consumed: 10, available: 90, packs: [] } }),
        accountRow({ id: 'a2', label: 'bob', disabled: true, credits: { total: 100, consumed: 0, available: 100, packs: [] } }),
        accountRow({ id: 'a3', label: 'carol', cooling: true, credits: { total: 50, consumed: 5, available: 45, packs: [] } }),
      ],
      preferredAccountId: 'a3',
    }) as unknown as TraePoolWebStatus)

    // 被停用的 bob 不出现：列出来再标「不可用」等于邀请用户点一个注定不生效的行。
    expect(rows.map(row => row.id)).toEqual(['a1', 'a3'])
    expect(rows[0]?.available).toBe(90)
    expect(rows[1]?.preferred).toBe(true)
    expect(rows[1]?.cooling).toBe(true)
  })

  it('没有状态文档时返回空行而不是抛错', () => {
    expect(toComposerRows(undefined)).toEqual([])
  })
})

describe('composer 门控与读数', () => {
  it('非本插件的 provider 渲染空', () => {
    const { container } = render(<ComposerCredits t={t} provider="deepseek" />)
    expect(container.textContent).toBe('')
  })

  it('触发器显示被钉住账号的可用积分', async () => {
    stubStatus(statusDocument({
      accounts: [
        accountRow({ id: 'a1', label: 'alice', credits: { total: 100, consumed: 10, available: 90, packs: [] } }),
        accountRow({ id: 'a2', label: 'bob', credits: { total: 100, consumed: 0, available: 100, packs: [] } }),
      ],
      preferredAccountId: 'a2',
    }))
    render(<ComposerCredits t={t} provider="connect-trae-models" />)

    // 读数跟着**被钉住**的账号走（bob=100），而不是列表第一个（alice=90）。
    await waitFor(() => {
      expect(screen.getByRole('button').textContent).toContain('100')
    })
    expect(screen.getByRole('button').textContent).toContain('composer.pointsCn')
  })

  it('没有钉选时读数取第一个可参与轮转的账号', async () => {
    stubStatus(statusDocument({
      accounts: [accountRow({ id: 'a1', label: 'alice', credits: { total: 100, consumed: 10, available: 90, packs: [] } })],
    }))
    render(<ComposerCredits t={t} provider="connect-trae-models" />)

    await waitFor(() => { expect(screen.getByRole('button').textContent).toContain('90') })
  })
})

describe('composer 切换账号', () => {
  it('点某个账号 POST 到 accounts/select，然后重新读一次状态', async () => {
    let pinned: string | undefined
    const urls = stubStatus(() => statusDocument({
      accounts: [
        accountRow({ id: 'a1', label: 'alice', credits: { total: 100, consumed: 10, available: 90, packs: [] } }),
        accountRow({ id: 'a2', label: 'bob', credits: { total: 100, consumed: 0, available: 100, packs: [] } }),
      ],
      preferredAccountId: pinned,
    } as unknown as TraePoolWebStatus))

    render(<ComposerCredits t={t} provider="connect-trae-models" />)
    await waitFor(() => { expect(screen.getByRole('button').textContent).toContain('90') })

    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => { expect(screen.getByText('bob')).toBeTruthy() })

    pinned = 'a2'
    fireEvent.click(screen.getByText('bob'))

    await waitFor(() => {
      const post = urls.find(url => url.startsWith('POST'))
      expect(post).toContain('/accounts/select')
      expect(post).toContain('"accountId":"a2"')
    })
    // 切换后必须重读状态，否则读数与标记都不会跟着动。
    // 面板打开后有多个 button，用触发器自身的类名定位，别写含糊的 role 查询。
    await waitFor(() => {
      expect(document.querySelector('.dsm-connect-trae-models-composer-trigger')?.textContent).toContain('100')
    })
  })

  it('面板打开时列出所有参与轮转的账号，被停用的不出现', async () => {
    stubStatus(statusDocument({
      accounts: [
        accountRow({ id: 'a1', label: 'alice' }),
        accountRow({ id: 'a2', label: 'bob', disabled: true }),
      ],
    }))
    render(<ComposerCredits t={t} provider="connect-trae-models" />)

    await waitFor(() => { expect(screen.getByRole('button').textContent).toContain('—') })
    fireEvent.click(screen.getByRole('button'))

    await waitFor(() => { expect(screen.getByText('alice')).toBeTruthy() })
    expect(screen.queryByText('bob')).toBeNull()
  })

  it('读失败保留上次数值并给出提示，而不是清空成空白', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => statusDocument({
            accounts: [
              accountRow({ id: 'a1', label: 'alice', credits: { total: 100, consumed: 10, available: 90, packs: [] } }),
              accountRow({ id: 'a2', label: 'bob', credits: { total: 100, consumed: 0, available: 100, packs: [] } }),
            ],
          }),
        } as unknown as Response
      }
      // 切换成功、随后的状态重读失败：这是真实会发生的组合（写生效了但读挂了）。
      return calls === 2
        ? ({ ok: true, status: 200, json: async () => ({}) } as unknown as Response)
        : ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)
    }))
    render(<ComposerCredits t={t} provider="connect-trae-models" />)

    await waitFor(() => {
      expect(document.querySelector('.dsm-connect-trae-models-composer-trigger')?.textContent).toContain('90')
    })

    fireEvent.click(document.querySelector('.dsm-connect-trae-models-composer-trigger') as HTMLElement)
    await waitFor(() => { expect(screen.getByText('bob')).toBeTruthy() })
    fireEvent.click(screen.getByText('bob'))

    // 面板里给出失败提示，但触发器上的数字仍在——对几乎没变化的余额来说，
    // 陈旧的数字好过空白。
    await waitFor(() => { expect(screen.getByText('composer.failed')).toBeTruthy() })
    expect(document.querySelector('.dsm-connect-trae-models-composer-trigger')?.textContent).toContain('90')
  })

  it('「恢复自动轮转」提交空 accountId', async () => {
    const urls = stubStatus(statusDocument({
      accounts: [accountRow({ id: 'a1', label: 'alice' })],
      preferredAccountId: 'a1',
    }))
    render(<ComposerCredits t={t} provider="connect-trae-models" />)

    await waitFor(() => { expect(screen.getByRole('button').textContent).toBeTruthy() })
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => { expect(screen.getByText('composer.clearPin')).toBeTruthy() })

    fireEvent.click(screen.getByText('composer.clearPin'))
    await waitFor(() => {
      const post = urls.find(url => url.startsWith('POST'))
      expect(post).toContain('"accountId":""')
    })
  })
})

describe('composer Gate（归属判定）', () => {
  it('selectedProviderOf：next 优先于 lastUsed', () => {
    expect(selectedProviderOf({ next: { provider: 'connect-trae-models' }, lastUsed: { provider: 'other' } })).toBe('connect-trae-models')
    expect(selectedProviderOf({ lastUsed: { provider: 'connect-trae-models-global' } })).toBe('connect-trae-models-global')
    expect(selectedProviderOf({ next: { provider: '' } })).toBeUndefined()
    expect(selectedProviderOf(undefined)).toBeUndefined()
  })

  it('composerRegionOf：只认本插件的 provider', () => {
    expect(composerRegionOf({ next: { provider: 'connect-trae-models' } })).toBe('cn')
    expect(composerRegionOf({ next: { provider: 'connect-trae-models-global' } })).toBe('ai')
    expect(composerRegionOf({ next: { provider: 'deepseek' } })).toBeUndefined()
  })

  it('当前模型不属于本插件时 Gate 渲染空（不启动拉取）', () => {
    stubStatus(statusDocument())
    const { container } = render(
      <ComposerCreditsGate t={t} useProjection={() => ({ next: { provider: 'deepseek' } })} />,
    )
    expect(container.textContent).toBe('')
  })

  it('当前模型属于本插件时 Gate 渲染读数', async () => {
    stubStatus(statusDocument({
      accounts: [accountRow({ id: 'a1', label: 'alice', credits: { total: 100, consumed: 10, available: 90, packs: [] } })],
    }))
    render(
      <ComposerCreditsGate t={t} useProjection={() => ({ next: { provider: 'connect-trae-models' } })} />,
    )
    await waitFor(() => { expect(screen.getByRole('button').textContent).toContain('90') })
  })
})

describe('composer 样式自包含注入', () => {
  it('组件模块一被 import 就把自己的 <style> 注入 document.head', async () => {
    // 对话栏常驻而插件设置卡片可能从未打开，所以对话栏样式必须自带注入；否则
    // 用户看到的是一个没有排版、没有去掉边框的原生按钮。
    await import('../src/client/ComposerCredits.tsx')
    const tag = document.head.querySelector('style[data-plugin-css="dsh-connect-trae-models/composer-credits.css"]')
    expect(tag).not.toBeNull()
    expect(tag?.textContent).toContain('.dsm-connect-trae-models-composer-trigger')
    // 触发器必须无边框（border:0），而不是一个带描边的胶囊按钮。
    expect(tag?.textContent).toMatch(/\.dsm-connect-trae-models-composer-trigger\{[^}]*border:0/)
  })

  it('重复 import 不会重复注入（幂等）', async () => {
    await import('../src/client/ComposerCredits.tsx')
    const count = document.head.querySelectorAll('style[data-plugin-css="dsh-connect-trae-models/composer-credits.css"]').length
    expect(count).toBe(1)
  })
})