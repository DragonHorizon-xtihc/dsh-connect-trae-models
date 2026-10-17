/**
 * Trae 稳定设备身份（移植自 dsh-connect-trae/src/identity.ts，语义逐字段保持）。
 *
 * machineId = storage 的 `telemetry.machineId`（官方聊天日志中 x-machine-id 的
 * 64 位来源，root machineid 文件仅作兜底）。
 * deviceId  = `iCubeAuthInfo://icube-dc:<id>` 的数字后缀 —— 官方 CN 聊天日志里
 * x-device-id 的判定量（必保留精确语义），telemetry.devDeviceId 兜底，最后才是
 * 由 machineId 派生的哈希。
 *
 * @module dsh-connect-trae-models/identity
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { cpus, homedir, release } from 'node:os'
import type { TraeEdition, TraeStorageCandidate } from './paths.ts'
import { traeWindowsAppNames } from './paths.ts'

export interface TraeIdentity {
  edition: TraeEdition
  machineId: string
  deviceId: string
  appVersion?: string
  buildVersion?: string
  deviceBrand?: string
  deviceCpu?: string
  osVersion?: string
  platform: NodeJS.Platform
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** `iCubeAuthInfo://icube-dc:` 前缀键对应的设备中心 id（恰为 x-device-id 判定来源）。 */
function deviceCenterId(storage: Record<string, unknown>): string | undefined {
  const prefix = 'iCubeAuthInfo://icube-dc:'
  const ids = Object.keys(storage).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)).filter(Boolean)
  return ids.length === 1 ? ids[0] : undefined
}

export interface TraeIdentityReadOptions {
  /** 测试用平台覆盖；默认 process.platform。 */
  platform?: NodeJS.Platform
  /** 测试用 home 覆盖；默认 homedir()。 */
  home?: string
  /** 测试用环境覆盖；默认 process.env。 */
  env?: NodeJS.ProcessEnv
}

/** 从 Trae 自有文件读取稳定身份，绝不伪造随机 id。 */
export async function readTraeIdentity(candidate: TraeStorageCandidate, options: TraeIdentityReadOptions = {}): Promise<TraeIdentity> {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const storage = JSON.parse(await readFile(candidate.path, 'utf8')) as Record<string, unknown>
  const appRoot = dirname(dirname(dirname(candidate.path)))
  const machineFile = nonEmpty(await readFile(join(appRoot, 'machineid'), 'utf8').catch(() => ''))
  const telemetryMachine = nonEmpty(storage['telemetry.machineId'])
  const devDevice = nonEmpty(storage['telemetry.devDeviceId'])
  const dcDevice = deviceCenterId(storage)
  // 历史官方聊天日志用 64 位 telemetry.machineId 作 x-machine-id；
  // root machineid 文件仅作兜底。
  const machineId = telemetryMachine ?? machineFile
  if (machineId === undefined) throw new Error(`Trae ${candidate.edition} has no stable machine identity`)
  // iCubeAuthInfo://icube-dc:<id> 的数字后缀与官方 CN 聊天日志观察到的
  // x-device-id 完全一致。telemetry 仅作兜底。
  const deviceId = dcDevice ?? devDevice ?? createHash('sha256').update(machineId).digest('hex').slice(0, 32)
  const buildVersion = nonEmpty(storage['iCubeLastVersion'])
  // product.json 持有真实客户端作为 x-app-version / x-ide-version 发送的版本号。
  // macOS 上该文件位于 `.app` bundle 内（bundle 名即产品名）；Windows 上位于
  // `%LOCALAPPDATA%\Programs\<安装目录>\resources\app`，安装目录名由安装器决定、
  // 从未在真实主机上确认 —— 因此使用与凭据扫描器同一组拼写（traeWindowsAppNames），
  // 让同一安装的两半保持一致。此处的失败绝不能破坏身份解析：按顺序尝试，
  // 不存在的候选直接跳过。
  const APP_NAMES_BY_EDITION: Readonly<Record<TraeEdition, string>> = {
    cn: 'Trae CN',
    sg: 'Trae',
    solo: 'TRAE SOLO CN',
    'solo-sg': 'TRAE SOLO',
  }
  const appName = APP_NAMES_BY_EDITION[candidate.edition]
  const productPaths: string[] = []
  if (appName !== undefined && (platform === 'darwin' || platform === 'win32')) {
    if (platform === 'darwin') {
      productPaths.push(join('/Applications', `${appName}.app`, 'Contents', 'Resources', 'app', 'product.json'))
    } else {
      const localRoots = [env.LOCALAPPDATA, join(home, 'AppData', 'Local')]
        .filter((value): value is string => typeof value === 'string' && value !== '')
        .filter((value, index, all) => all.indexOf(value) === index)
      for (const root of localRoots) {
        for (const spelling of traeWindowsAppNames(candidate.edition)) {
          productPaths.push(join(root, 'Programs', spelling, 'resources', 'app', 'product.json'))
        }
      }
    }
  }
  let product: Record<string, unknown> = {}
  for (const path of productPaths) {
    try { product = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; break } catch {}
  }
  const appVersion = nonEmpty(product['appVersion'])
  const deviceBrand = platform === 'darwin' ? nonEmpty(env['TRAE_DEVICE_BRAND']) : undefined
  const deviceCpu = cpus()[0]?.model.split(' ')[0]
  const osVersion = `${platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform} ${release()}`
  return {
    edition: candidate.edition,
    machineId,
    deviceId,
    ...appVersion === undefined ? {} : { appVersion },
    ...buildVersion === undefined ? {} : { buildVersion },
    ...deviceBrand === undefined ? {} : { deviceBrand },
    ...deviceCpu === undefined ? {} : { deviceCpu },
    osVersion,
    platform,
  }
}

/** 判断某错误是否为「storage 文件不存在」（区别于解析/身份错误）。 */
function isFileMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

/** 「磁盘上没有任何候选存在」错误的前缀；见 {@link pickTraeStorageIdentity}。 */
const STORAGE_MISSING_PREFIX = 'Trae storage was not found'

/**
 * 按顺序尝试候选并返回第一个能得到有效身份的；全部失败才硬报错。
 * 与凭据存储的 skip-missing 语义一致：只有 SOLO（没有 CN 安装）的机器也能正确
 * 解析，而不是钉死第一个候选然后在文件缺失上抛错。当所有候选都不在磁盘上时，
 * 错误里列出全部尝试过的路径；存在但解析失败的候选则暴露其自身错误。
 */
export async function pickTraeStorageIdentity(
  candidates: readonly TraeStorageCandidate[],
  options: TraeIdentityReadOptions = {},
): Promise<TraeIdentity> {
  let lastError: unknown
  let anyPresent = false
  for (const candidate of candidates) {
    try {
      return await readTraeIdentity(candidate, options)
    } catch (error) {
      lastError = error
      if (!isFileMissing(error)) anyPresent = true
    }
  }
  const tried = candidates.map(item => item.path).join(' or ')
  if (!anyPresent) throw new Error(`${STORAGE_MISSING_PREFIX} (${tried})`)
  throw lastError instanceof Error ? lastError : new Error(`Trae identity could not be resolved (${tried})`)
}

/** 每个 edition 的 CLI 点前缀 home；CLI 用自己的 home，而不是 Application Support 条目。 */
const CLI_HOME_BY_EDITION: Readonly<Record<TraeEdition, string>> = {
  cn: '.trae-cn',
  solo: '.trae-cn',
  sg: '.trae',
  'solo-sg': '.trae',
}

/**
 * 只有 Trae CLI（`traecli`）的机器上的确定性身份。
 *
 * CLI-only 机器没有桌面 `storage.json`，桌面身份读取器无从读取 —— 但请求头仍然
 * 需要稳定的 machine/device id。以下一切来自 CLI 自己持久化的标识符（绝非
 * 每次请求的随机值）：
 *
 *   - `argv.json` 的 `crash-reporter-id` —— CLI 首次运行写入的稳定 per-install
 *     UUID，直接用作 device id。
 *   - `builtin/ide_version.json` 的 `version` —— CLI 构建，作为 `x-app-version`
 *     发送（桌面读取器从 `product.json` 拿它）。
 *   - device id + 主机名 + 用户名的 SHA-256 作 `machineId`，与官方客户端发送的
 *     64 位十六进制形状一致。
 *
 * `crash-reporter-id` 缺失时 device id 回退到同一哈希（仍然确定性）。完全没有
 * CLI home 的机器继续响亮地失败 —— 伪造的身份比可见的「未登录」更糟。
 */
export async function readTraeCliIdentity(
  edition: TraeEdition,
  options: TraeIdentityReadOptions = {},
): Promise<TraeIdentity> {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const cliHome = join(home, CLI_HOME_BY_EDITION[edition])
  const argv = await readJsonFile(join(cliHome, 'argv.json'))
  const version = await readJsonFile(join(cliHome, 'builtin', 'ide_version.json'))
  const crashReporterId = nonEmpty(argv?.['crash-reporter-id'])
  const host = nonEmpty(env['HOSTNAME']) ?? await readHostname() ?? 'unknown-host'
  const user = nonEmpty(env['USER']) ?? nonEmpty(env['USERNAME']) ?? 'unknown-user'
  const deviceId = crashReporterId ?? createHash('sha256').update(`trae-cli\0${host}\0${user}`).digest('hex').slice(0, 32)
  const machineId = createHash('sha256').update(`trae-cli-machine\0${deviceId}\0${host}`).digest('hex')
  const appVersion = nonEmpty(version?.['version'])
  const deviceCpu = cpus()[0]?.model.split(' ')[0]
  const osVersion = `${platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform} ${release()}`
  return {
    edition,
    machineId,
    deviceId,
    ...appVersion === undefined ? {} : { appVersion },
    ...deviceCpu === undefined ? {} : { deviceCpu },
    osVersion,
    platform,
  }
}

/** 读取并解析 JSON 文件，容忍缺失与损坏内容。 */
async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** OS 主机名，不可用时返回 undefined。 */
async function readHostname(): Promise<string | undefined> {
  try {
    const { hostname } = await import('node:os')
    return nonEmpty(hostname())
  } catch {
    return undefined
  }
}

/**
 * 解析一个 region 的请求身份：存在任何桌面安装时用桌面 storage 身份，
 * 否则用 CLI home 的确定性身份（见 {@link readTraeCliIdentity}）。
 *
 * 这是 WSL2 / CLI-only 场景需要的接缝：`traecli` 把 token 写到
 * `~/.trae-cn/trae-jwt-token`，磁盘上没有任何 `storage.json`，仅支持桌面的
 * 解析曾让目录刷新与聊天请求全部失败，即使账号本身已找到。
 */
export async function resolveTraeIdentity(
  candidates: readonly TraeStorageCandidate[],
  edition: TraeEdition,
  options: TraeIdentityReadOptions = {},
): Promise<TraeIdentity> {
  try {
    return await pickTraeStorageIdentity(candidates, options)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith(STORAGE_MISSING_PREFIX)) throw error
    return readTraeCliIdentity(edition, options)
  }
}

/** 由真实持久化身份派生的请求头，绝非每请求新造的随机身份。 */
export function identityHeaders(identity: TraeIdentity): Record<string, string> {
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
