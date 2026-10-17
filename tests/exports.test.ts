/**
 * T4/T5 验收：公共 API 面必须全部可从 index.ts 导入。
 *
 * 这条用例的存在理由：契约要求「导出 TraeUpstreamClient、classifyTraeError、
 * TraeCatalog、FALLBACK_TRAE_MODELS(_AI)、prepareSoloBody、bridgeTraeSoloStream
 * 供 T4/T5 使用」，以及上游客户端的八个方法级函数。tycheck 不会发现「某个名字
 * 忘了从入口再导出」，只有真的 import 一次才会——下游装配任务因此不必回头改本文件。
 */

import { describe, expect, it } from 'vitest'
import {
  bridgeTraeSoloStream,
  buildTraeHeaders,
  chatStream,
  claimCheckin,
  classifyTraeError,
  FALLBACK_TRAE_MODELS,
  FALLBACK_TRAE_MODELS_AI,
  fetchActivities,
  fetchCheckinStatus,
  fetchCredits,
  fetchModels,
  fetchRemoteCatalog,
  mergeCatalog,
  parseReasoningCapability,
  parseTraeRemoteModel,
  prepareSoloBody,
  refreshTraeCredential,
  REGION_GATEWAYS,
  resolveTraeIdentity,
  SseDecoder,
  TraeAccountPool,
  TraeCatalog,
  TraeCredentialStore,
  TraeUpstreamClient,
} from '../src/index.ts'

describe('验收：index.ts 公共 API 面', () => {
  it('契约点名的两个类与四组常量/函数可导入', () => {
    expect(typeof TraeUpstreamClient).toBe('function')
    expect(typeof TraeCatalog).toBe('function')
    expect(typeof classifyTraeError).toBe('function')
    expect(typeof prepareSoloBody).toBe('function')
    expect(typeof bridgeTraeSoloStream).toBe('function')
    expect(FALLBACK_TRAE_MODELS.length).toBe(4)
    expect(FALLBACK_TRAE_MODELS_AI.length).toBe(7)
  })

  it('上游客户端的八个方法级函数可单独导入', () => {
    for (const fn of [fetchModels, fetchRemoteCatalog, mergeCatalog, chatStream, fetchCredits, fetchCheckinStatus, claimCheckin, fetchActivities]) {
      expect(typeof fn).toBe('function')
    }
  })

  it('多账号层与协议层同样从入口导出（T5 装配依赖）', () => {
    for (const value of [TraeCredentialStore, TraeAccountPool, resolveTraeIdentity, refreshTraeCredential, buildTraeHeaders, REGION_GATEWAYS, SseDecoder, parseReasoningCapability, parseTraeRemoteModel]) {
      expect(value).toBeDefined()
    }
  })

  it('TraeUpstreamClient 实例暴露契约要求的全部方法', () => {
    const client = new TraeUpstreamClient()
    for (const method of ['fetchModels', 'fetchRemoteCatalog', 'mergeCatalog', 'chatStream', 'fetchCredits', 'fetchCheckinStatus', 'claimCheckin', 'fetchActivities'] as const) {
      expect(typeof client[method]).toBe('function')
    }
  })

  it('classifyTraeError 分类语义（401/403→authentication、402→hard_credit、429→soft_rate）', () => {
    expect(classifyTraeError(401)).toBe('authentication')
    expect(classifyTraeError(403)).toBe('authentication')
    expect(classifyTraeError(402)).toBe('hard_credit')
    expect(classifyTraeError(429)).toBe('soft_rate')
    expect(classifyTraeError(404)).toBe('not_found')
    expect(classifyTraeError(500)).toBe('server')
    expect(classifyTraeError(400)).toBe('client')
  })

  it('方法级 mergeCatalog 与实例方法同语义（薄包装）', () => {
    const remote = [{ id: 'glm-5.2', name: 'GLM-5.2', multimodal: false, contextWindow: 200_000, reasoningSupported: false }]
    const wire = [{ id: 'glm-5.2', name: 'GLM-5.2', creditMultiplier: 0.08, function: 'solo_work_remote' }]
    const viaFunction = mergeCatalog(remote, wire)
    const viaInstance = new TraeUpstreamClient().mergeCatalog(remote, wire)

    expect(viaFunction).toEqual(viaInstance)
    expect(viaFunction[0]).toMatchObject({ multiplier: 0.08, wireFunction: 'solo_work_remote' })
  })
})
