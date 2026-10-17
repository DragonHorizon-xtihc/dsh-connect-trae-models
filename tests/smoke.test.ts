import { describe, expect, it } from 'vitest'
// 冒烟测试：验证测试管线与入口模块导入正常。后续随实现补充真实用例。
import { apply, inject, name } from '../src/index.ts'

describe('dsh-connect-trae-models 骨架冒烟', () => {
  it('入口导出 cordis 插件 id 与依赖注入列表', () => {
    expect(name).toBe('llm-connect-trae-models')
    // T5 装配后注入面固定为 llm（注册 provider/adapter）与 settings（挂卡片）。
    expect(inject).toEqual(['llm', 'settings'])
    expect(typeof apply).toBe('function')
  })

  it('数值断言（管线自检）', () => {
    expect(1).toBe(1)
  })
})
