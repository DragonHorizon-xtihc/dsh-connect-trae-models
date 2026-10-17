/**
 * Trae 请求头构造。移植自 dsh-connect-trae protocol.ts，语义不变：
 * - `Authorization: Cloud-IDE-JWT <token>` 认证；
 * - identity 头（x-machine-id / x-device-id 等）来自真实持久化的身份，绝不伪造；
 * - `x-app-version-code` 必须数字化——上游把该字段绑定为 number，点分构建串
 *   会被 `4001 ... parameter type does not match binding data` 拒绝
 *   （dsh-connect-trae 2026-08-29 实测）。
 *
 * 多账号版差异：方法接收 `{ credential, identity }` 对象而不是依赖注入的
 * 单账号 getter，让上游客户端可以按池内任意账号发请求。
 *
 * @module dsh-connect-trae-models/protocol
 */

import { randomUUID } from 'node:crypto'

/** 多账号场景下的请求身份包：凭据 + 本机稳定身份。 */
export interface TraeRequestIdentity {
  /** 必备：凭据字段（与 dsh-connect-trae 的 TraeCredential 兼容，鸭子类型）。 */
  credential: {
    accessToken: string
    userId: string
    edition: TraeEditionImported
  }
  /** 必备：本机身份（machineId/deviceId 等；deviceId 是签到 x-device-id 的判定量）。 */
  identity: {
    machineId: string
    deviceId: string
    appVersion?: string
    buildVersion?: string
    deviceBrand?: string
    deviceCpu?: string
    osVersion?: string
    platform: string
  }
}

// 仅用于类型位置的 edition 联合；从 region 模块重导出会形成运行时依赖，
// 这里用结构类型保持 protocol 模块零上游依赖。
type TraeEditionImported = 'cn' | 'sg' | 'solo' | 'solo-sg'

/** 从 identityHeaders 平铺出的身份头集合（键名与官方客户端观测一致）。 */
function identityHeaders(identity: TraeRequestIdentity['identity']): Record<string, string> {
  return {
    'x-machine-id': identity.machineId,
    'x-device-id': identity.deviceId,
    'x-device-type': identity.platform === 'darwin' ? 'mac' : identity.platform === 'win32' ? 'windows' : identity.platform,
    ...identity.deviceBrand === undefined ? {} : { 'x-device-brand': identity.deviceBrand },
    ...identity.deviceCpu === undefined ? {} : { 'x-device-cpu': identity.deviceCpu },
    ...identity.osVersion === undefined ? {} : { 'x-os-version': identity.osVersion },
    ...identity.appVersion === undefined ? {} : { 'x-app-version': identity.appVersion, 'x-ide-version': identity.appVersion },
    ...identity.buildVersion === undefined ? {} : { 'x-app-version-code': identity.buildVersion, 'x-ide-version-code': identity.buildVersion },
    'x-ide-version-type': 'stable',
  }
}

export type TraeHeaderProfile = 'model-detail' | 'chat' | 'pay'

/**
 * 上游无法绑定时的兜底构建号（dsh-connect-trae 观测值，保持一致便于对照）。
 */
export const TRAE_VERSION_CODE_FALLBACK = '20260716'

/** 保留纯数字构建版本；无法绑定时回退。 */
export function normalizeTraeVersionCode(buildVersion: string | undefined): string {
  if (buildVersion === undefined || buildVersion.trim() === '') return TRAE_VERSION_CODE_FALLBACK
  const trimmed = buildVersion.trim()
  return /^\d+$/.test(trimmed) ? trimmed : TRAE_VERSION_CODE_FALLBACK
}

/** 默认 x-app-id（两个区域网关共用，dsh-connect-trae 实测一致）。 */
export const TRAE_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'

/**
 * 请求头全集。chat/model-detail 走完整头集；pay 家族只需认证 + 基本头
 * （dsh-connect-trae usage.ts 的 authedHeaders 形态），并把 `x-device-id`
 * 单独控制——签到 claim 必须带、其余路由可选。
 */
export function buildTraeHeaders(
  request: TraeRequestIdentity,
  options: { appId?: string; requestId?: string; profile?: TraeHeaderProfile; deviceId?: string } = {},
): Record<string, string> {
  const requestId = options.requestId ?? randomUUID()
  const traceId = requestId.replaceAll('-', '').slice(0, 32)
  const profile = options.profile ?? 'chat'
  const appId = options.appId ?? TRAE_APP_ID
  const auth = {
    'Authorization': `Cloud-IDE-JWT ${request.credential.accessToken}`,
    'X-Ide-Token': request.credential.accessToken,
    'Content-Type': 'application/json',
  }
  if (profile === 'pay') {
    return {
      ...auth,
      'User-Agent': 'Mozilla/5.0',
      'Origin': 'https://www.trae.cn',
      'Referer': 'https://www.trae.cn/',
      ...options.deviceId === undefined || options.deviceId === '' ? {} : { 'x-device-id': options.deviceId },
    }
  }
  const common = {
    ...auth,
    'x-plugin-channel': 'icube-ai',
    'User-Agent': `Trae/${request.identity.appVersion ?? request.identity.buildVersion ?? 'unknown'}`,
    'x-app-id': appId,
    ...identityHeaders(request.identity),
    // 上游把这两个绑定为数字；点分构建串会被拒绝，因此数字化。
    'x-app-version-code': normalizeTraeVersionCode(request.identity.buildVersion),
    'x-ide-version-code': normalizeTraeVersionCode(request.identity.buildVersion),
    'x-custom-trace-id': traceId,
    'x-flow-traceparent': `04-${traceId}-${traceId.slice(0, 16)}-01`,
    'request-traffic-type': 'prod',
  }
  if (profile === 'model-detail') return { ...common, 'Accept': 'application/json' }
  return { ...common, 'Accept': 'text/event-stream' }
}

/** URL 拼接：去掉多余斜杠。 */
export function traeEndpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}
