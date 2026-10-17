/**
 * Trae token 刷新契约（移植自 dsh-connect-trae/src/refresh.ts，语义逐字段保持）。
 *
 * 刷新端点是唯一按 edition（而非 region）分叉的契约：桌面版（CN 与国际）加
 * SOLO CN 都走 `/cloudide/...` 路径与共享 ClientID；TRAE SOLO 国际版走较新的
 * `/trae/api/v3/oauth/` 路径、自己的 ClientID 且带 DeviceInfo body（2026-09-15
 * 官方应用自测）。每个请求都挂在凭据自己的 host 上，绝不硬编码 base。
 *
 * @module dsh-connect-trae-models/refresh
 */

import type { TraeCredential, TraeRefreshOutcome } from './auth.ts'
import type { TraeEdition } from './paths.ts'
import { hostname } from 'node:os'

/** 每 edition 的刷新契约。 */
interface TraeRefreshContract {
  readonly path: string
  readonly clientId: string
  /** 官方客户端是否在 body 中发送 DeviceInfo 对象。 */
  readonly deviceInfo: boolean
}

const REFRESH_CONTRACT: Readonly<Record<TraeEdition, TraeRefreshContract>> = {
  cn: { path: '/cloudide/api/v3/trae/oauth/ExchangeToken', clientId: 'ono9krqynydwx5', deviceInfo: false },
  sg: { path: '/cloudide/api/v3/trae/oauth/ExchangeToken', clientId: 'ono9krqynydwx5', deviceInfo: false },
  solo: { path: '/cloudide/api/v3/trae/oauth/ExchangeToken', clientId: 'ono9krqynydwx5', deviceInfo: false },
  'solo-sg': { path: '/trae/api/v3/oauth/ExchangeToken', clientId: 'en1oxy7wnw8j9n', deviceInfo: true },
}

/** DeviceInfo body 用的稳定设备身份，来自应用自己的 storage。 */
export interface TraeRefreshDevice {
  deviceId: string
  machineId: string
}

function normalizeHost(host: string): string {
  const value = host.trim()
  if (value === '') throw new Error('Trae refresh host is missing')
  return value.replace(/\/$/, '')
}

/**
 * 用 refresh token 换新 access token，遵循调用 edition 的已验证契约。
 * `device` 只被官方客户端发送 DeviceInfo body 的 edition 使用；无法解析时
 * 省略该字段而不是发送空值。
 */
export async function refreshTraeCredential(
  credential: TraeCredential,
  signal?: AbortSignal,
  device?: TraeRefreshDevice,
): Promise<TraeRefreshOutcome> {
  const contract = REFRESH_CONTRACT[credential.edition]
  if (contract === undefined) throw new Error(`Trae ${credential.edition} refresh contract is not verified`)
  if (credential.refreshToken === undefined) throw new Error('Trae refresh token is missing')
  const body: Record<string, unknown> = {
    ClientID: contract.clientId,
    ClientSecret: '-',
    RefreshToken: credential.refreshToken,
    UserID: credential.userId,
  }
  if (contract.deviceInfo && device !== undefined) {
    body['DeviceInfo'] = {
      DeviceID: device.deviceId,
      MachineID: device.machineId,
      PlatformCode: credential.edition === 'solo-sg' ? 'SOLO_PC' : 'TRAE',
      DeviceType: 'PC',
      DeviceName: hostname(),
    }
  }
  const response = await fetch(`${normalizeHost(credential.host)}${contract.path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Trae token refresh failed (http ${response.status})`)
  const payload = await response.json() as { Result?: Record<string, unknown> }
  const result = payload.Result
  const accessToken = typeof result?.['Token'] === 'string' ? result['Token'] : ''
  if (accessToken === '') throw new Error('Trae token refresh returned no token')
  const expiry = result?.['TokenExpireAt']
  const expiresAtMs = typeof expiry === 'number' ? expiry : typeof expiry === 'string' ? Date.parse(expiry) : Number.NaN
  if (!Number.isFinite(expiresAtMs)) throw new Error('Trae token refresh returned an invalid expiry')
  const refreshToken = typeof result?.['RefreshToken'] === 'string' && result['RefreshToken'] !== '' ? result['RefreshToken'] : undefined
  return { accessToken, ...refreshToken === undefined ? {} : { refreshToken }, expiresAtMs }
}
