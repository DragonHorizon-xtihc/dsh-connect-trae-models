/**
 * 浏览器半区：Trae Connect Models 的健康与模型目录，作为设置面板左侧导航里的一页。
 *
 * 注册形状（这段 NOTE 说明了为什么这样选 —— 槽位与注入服务的选择直接决定这个
 * 半区能否加载）：
 *
 *  - `inject` **只**列两条宿主线都存在的服务。cordis 的依赖闸门是硬的：一个
 *    运行线不提供的 inject 条目会让 `apply` 永不执行，该条目永远停在 PENDING，
 *    于是桌面包报 "renderer boot failed (plugins: dsh-connect-trae-models)" 并拒绝打开。
 *    `settingsScope`（0.1.5）与 `configForms`（0.1.7）是同一件事在两个版本上的
 *    互斥命名，所以二者都不能写进 inject；哪一个存在由 `apply` 内的 `ctx.get()`
 *    探测。
 *  - 页面注册进 `settings.section`：两条宿主线都声明它，也正是它会在设置面板
 *    左侧导航里放一行 —— 和内置的「通用 / 模型 / 插件」页用的是同一个槽位。
 *
 * 整个函数体包在 try/catch 里：槽位 API 变化时降级成 console.error，而不是触发
 * 宿主的 "Failed to load plugins" 横幅。
 *
 * @module dsh-connect-trae-models/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// `settings.section` 的 SlotMap key 由宿主的设置外壳
// （@deepseek-ai/dsh-client-ui-settings）声明，而它只是宿主提供的 peer、不是本
// 包的构建依赖：钉住它会让本 bundle 的类型跟随某一条宿主线而破坏另一条。下面
// import 的两个包声明了本文件用到的两个座位（slots、locale），section 注册则在
// 调用点就地收窄。
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { TraePoolCard } from './TraePoolCard.tsx'
import type { TraePoolCardInjected } from './TraePoolCard.tsx'
import { ComposerCredits } from './ComposerCredits.tsx'
import type { ComposerCreditsInjected } from './ComposerCredits.tsx'
import { ComposerCreditsGate } from './ComposerCreditsGate.tsx'
import { en, zh } from './locales.ts'
import type { TraePoolSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Trae Connect Models 卡片文案。命名空间为 `settings.<TRAE_POOL_SETTINGS_NS>`。 */
    'settings.connect-trae-models': TraePoolSettingsKey
  }

  interface SlotMap {
    /**
     * 每个列表项一个设置页，渲染为设置面板左侧导航里的一行。由宿主的设置外壳
     * 声明，此处就地重申契约，让下面的注册在两条宿主线上都有类型。
     */
    'settings.section': {
      kind: 'list'
      scope: 'root'
      owner: { close: () => void }
    }
  }
}

/**
 * 本入口需要的浏览器插件上下文。
 *
 * 卡片用到的 `slots` / `locale` 两个座位由上面 import 的客户端子路径模块声明，
 * cordis 自己的 `Context` 承载 `effect` fiber API。
 */
export type TraePoolClientContext = Context & {
  /** 槽位注册面（由宿主客户端运行时增强到 cordis 的 Context 上）。 */
  slots: {
    inject(key: string, callback: () => unknown): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  /** 本地化绑定面（同样来自宿主运行时增强）。 */
  locale: {
    register(namespace: string, dictionaries: { zh: unknown; en: unknown }): () => void
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
  }
}

/** 稳定的浏览器插件名。 */
export const name = 'dsh-connect-trae-models-client'

/**
 * 设置页需要的客户端服务。
 *
 * 刻意只列两条宿主线都提供的服务。设置面按线而异：0.1.5 提供 `settingsScope`，
 * 0.1.7 用 `configForms` 取代它，而 cordis 的依赖闸门是硬的：任何运行线不提供
 * 的 inject 条目都会让 `apply` 永不执行。用 `ctx.get()` 探测实际存在的那一个
 * （服务缺失时返回 undefined，绝不抛错）是「一份构建服务两条线」的关键。
 */
export const inject = ['slots', 'locale']

/** 宿主侧分区注册的 settings 命名空间（与宿主入口共用）。 */
const TRAE_POOL_SETTINGS_NS = 'connect-trae-models'

/**
 * `cordis.patch.yml` 里挂载本 bundle 的宿主插件条目 id。
 *
 * 0.1.7 线上 `configForms` 以这个 id 寻址。
 */
const TRAE_POOL_ENTRY_ID = 'llm-connect-trae-models'

/** 注册卡片文案与设置面板下的账号池页。 */
export function apply(ctx: TraePoolClientContext): void {
  try {
    const namespace = 'settings.connect-trae-models'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-connect-trae-models: settings copy')
    const t = ctx.locale.bind(namespace) as TraePoolCardInjected['t']

    // 软探测服务。直接属性访问一个未声明的服务会**抛错**
    // （"cannot get property X without inject"）—— `?.` 只挡 null/undefined，
    // 挡不住抛错的 getter；而 `ctx.get()` 对缺失服务返回 undefined。
    // 永远不要直接碰 `ctx.configForms` / `ctx.settingsScope`。
    const softGet = (serviceName: string): unknown =>
      (ctx as unknown as { get(name: string): unknown }).get(serviceName)

    const settingsScope = resolveSettingsScope(softGet)

    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'connect-trae-models',
      // 排在内置页面之后（通用 0 / 模型 10 / 插件 15 / presets 20 / market 40），
      // 让账号池与其他社区页并列，而不是把第一方页面挤下去。
      order: 441,
      // 传 thunk 而不是解析好的字符串：外壳每次投影都会重读它，于是语言切换后
      // 导航行会跟着变，而不需要本条目重新注册。
      label: () => t('row.navLabel'),
      inject: (): Partial<TraePoolCardInjected> => settingsScope === undefined
        ? { t }
        : { t, settingsScope },
    }, TraePoolCard))

    // 对话栏工具行（`conversation.input.left`）：积分读数 + 点开切换用户。
    //
    // 注册是无条件的，**是否渲染由 Gate 决定**：Gate 读宿主的 `modelSelection`
    // 投影，只在本会话选中的模型属于本插件时才画——这样两个 connector 插件不会
    // 争抢同一行，且切到别的 provider 时既不渲染也不启动拉取循环。
    //
    // 软探测该插槽：宿主版本或外壳版本不提供它时整段跳过，而不是抛错让整个
    // 客户端半端加载失败——那会连设置卡片一起赔进去。`as never` 是必要的：
    // 插槽键由外壳声明，不是本 bundle 的构建依赖，写死字面量再断言一次，
    // 两个宿主线路都能编过。
    const conversationSlot = 'conversation.input.left'
    const hasConversationSlot = (ctx.slots as unknown as {
      inject?: (key: string, callback: () => unknown) => () => void
    }).inject !== undefined
    if (hasConversationSlot) {
      try {
        ctx.slots.inject(conversationSlot as never, () => (ctx.slots as unknown as {
          register(
            options: {
              name: string
              id: string
              order: number
              locale: string
              inject: () => Partial<ComposerCreditsInjected> & {
                useProjection?: (key: 'modelSelection') => unknown
              }
            },
            component: unknown,
          ): () => void
        }).register({
          name: conversationSlot,
          id: 'connect-trae-models-composer',
          // 排在外壳自带控件之后，避免挤占内置按钮。
          order: 4,
          locale: namespace,
          // 只回 t 与 settingsScope：Gate 用来读宿主投影的 `useProjection` 钩子
          // 是**插槽框架自己注入**到组件 props 上的（与参照插件一致），不从这里
          // 返回——这里也没有那个符号可引。
          inject: (): Partial<ComposerCreditsInjected> => settingsScope === undefined
            ? { t }
            : { t, settingsScope },
        }, ComposerCreditsGate))
      } catch (error: unknown) {
        console.error('[dsh-connect-trae-models] composer 插槽注册失败（宿主 provider 不受影响）：', error)
      }
    }
  } catch (error: unknown) {
    // 页面上静默降级：账号池 provider 仍然在服务模型。
    // 开发者能在浏览器控制台看到完整原因；用户看不到横幅。
    console.error('[dsh-connect-trae-models] 客户端页面加载失败（宿主 provider 不受影响）：', error)
  }
}

/**
 * 绑定卡片读写所用的设置表单，取运行线上实际存在的那一条。
 *
 * 0.1.7 暴露 `configForms.get(entryId)`，以**宿主插件条目 id** 为键 —— 即
 * `cordis.patch.yml` 里注册的 id，而不是 settings 命名空间。0.1.5 暴露
 * `settingsScope.bind({ namespace })`，以宿主侧 `installSection` 注册的命名空间
 * 为键。两个控制器回答同一对方法（`getSnapshot()`、`set(field, value)`），所以
 * 卡片自身不需要按线分支。
 *
 * 两者都不存在时返回 undefined（受限宿主）：卡片退化为只读，这是文档化的降级。
 */
function resolveSettingsScope(
  softGet: (serviceName: string) => unknown,
): TraePoolCardInjected['settingsScope'] | undefined {
  // 0.1.7 线。条目 id 由宿主决定（profile patch 可能把本插件挂成
  // `dsh-connect-trae-models`，也可能像线上桌面宿主那样挂成
  // `include:dsh-connect-trae-models`），所以问镜像它服务哪个命名空间，而不是假定一个
  // 名字：宿主对 provider 的命名空间按精确匹配解析，猜错就把卡片绑到一个没人
  // 服务的命名空间上，每次保存都静默空转。
  const forms = softGet('configForms') as {
    describe(): { getSnapshot(): { view?: { namespaces?: { ns: string }[] } } }
    get(ns: string): TraePoolCardInjected['settingsScope']
  } | undefined
  if (forms !== undefined) {
    let entryId = TRAE_POOL_ENTRY_ID
    try {
      const namespaces = forms.describe().getSnapshot().view?.namespaces ?? []
      const served = namespaces.find(entry => entry.ns === TRAE_POOL_ENTRY_ID)
        ?? namespaces.find(entry => /connect-trae-models/.test(entry.ns))
      if (served !== undefined) entryId = served.ns
    } catch {
      // 镜像尚未就绪：声明的条目 id 仍是正确答案。
    }
    return forms.get(entryId)
  }

  // 0.1.5 线。
  const scope = softGet('settingsScope') as {
    bind(spec: { namespace: string }): TraePoolCardInjected['settingsScope']
  } | undefined
  if (scope !== undefined) return scope.bind({ namespace: TRAE_POOL_SETTINGS_NS })

  return undefined
}
