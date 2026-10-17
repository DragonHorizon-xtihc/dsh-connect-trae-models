/**
 * 对话栏积分面板需要的两个外壳行为：把面板挂在触发器上，以及在点击外部时关闭。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 该项目的 `client/popover.ts`；它本身又沿用 dsh-connect-trae 的同一份
 *   判断：同样的上下放置、同样的视口收边、同样的 scroll(capture)/resize/自身
 *   尺寸变化重测、同样的「pointerdown 落在触发器与面板之外即关闭」。这些不是
 *   随手写的——那边 2.12.0/2.13.0 的客户端加载失败与面板位置错乱都留下了记录，
 *   这里直接采用其最终结论。
 *
 * 本地实现而不是从 `@deepseek-ai/dsh-client-ui-primitives` 引入：外壳确实为
 * 插件 bundle 注册了该包，引入是合法的，这是一个主动选择而不是绕路——两个
 * 行为只有几十行 DOM 几何，自己持有可以让组件在 Node 测试套件里直接渲染，
 * 不必去 mock 一个自身还要拉 `*.module.css` 和更多 DSH 依赖的包。
 *
 * 一个被记下来的误诊（保留是因为它总会被重新提起）：参照项目那次客户端加载
 * 失败最初被归因于引入 primitives 包，其实不是。真正的原因是
 * `import { createPortal } from 'react-dom'` 被**打包进去**而不是外部化——内联
 * 的开发版开头就是 `process.env.NODE_ENV`，在浏览器里抛
 * `ReferenceError: process is not defined`，且发生在模块求值期，于是整个客户端
 * 半端都 import 失败。修法见 `tsdown.config.ts` 的 `CLIENT_EXTERNALS`。
 */
import { useEffect, useLayoutEffect, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'

/** {@link useAnchoredPosition} 的入参。 */
export interface AnchoredPositionOptions {
  /** 浮层是否已挂载、是否要跟随锚点。 */
  open: boolean
  /** 面板所依附的元素。 */
  anchorRef: RefObject<HTMLElement | null>
  /** 浮层本身，测量它才能用真实尺寸做收边。 */
  panelRef: RefObject<HTMLElement | null>
  /** 挂在锚点的哪一边：上方（`top`）或下方（`bottom`）。 */
  side?: 'top' | 'bottom'
  /** 与锚点的哪条边对齐：左（`start`）或右（`end`）。 */
  align?: 'start' | 'end'
  /** 与 `side` 所指锚点边之间保留的距离。 */
  gap: number
  /** 与视口各边保留的距离。 */
  margin: number
}

/**
 * 距视口顶部要留出的余量。
 *
 * 外壳在窗口顶部为窗口边框保留了一条带（`--dsh-frame-top-clearance`），只看
 * `margin` 收边的话面板仍可能压在它下面。变量缺失或没有 `data-fullscreen` 区分
 * 时按外壳同样的方式处理：退回 `min`。
 */
export function overlayTopMargin(min: number): number {
  if (typeof document === 'undefined') return min
  const root = document.documentElement
  const clearance = Number.parseFloat(getComputedStyle(root).getPropertyValue('--dsh-frame-top-clearance'))
  if (Number.isNaN(clearance)) return min
  return Math.max(min, (root.hasAttribute('data-fullscreen') ? 0 : clearance) + 20)
}

/** 让一个 `position: fixed` 浮层锚定在触发器上。 */
export function useAnchoredPosition(options: AnchoredPositionOptions): CSSProperties | null {
  const { open, anchorRef, panelRef, side = 'bottom', align = 'start', gap, margin } = options
  const [position, setPosition] = useState<CSSProperties | null>(null)

  // 用 layout effect：首次测量发生在打开面板的那次提交里，于是收边在任何绘制
  // 之前就拿到了真实尺寸，面板不会在错误位置闪一下。
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return undefined
    }
    const place = (): void => {
      const rect = anchorRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const panel = panelRef.current
      const width = panel?.offsetWidth ?? 0
      const height = panel?.offsetHeight ?? 0
      let left = align === 'end' ? rect.right - width : rect.left
      let top = side === 'top' ? rect.top - gap - height : rect.bottom + gap
      // 只在尺寸已知的轴上收边：零测量会把面板钉死在 margin 上。
      if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin)
      if (height > 0) top = Math.min(Math.max(top, overlayTopMargin(margin)), window.innerHeight - height - margin)
      setPosition({ left, top })
    }
    place()
    // 捕获阶段：祖先滚动容器也会移动锚点，冒泡阶段挂在 window 上收不到。
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    // 面板自身高度会在这两个事件都不触发的情况下变化（比如多出一行状态），
    // 过期的收边会让它越过本应遵守的边距。jsdom 下没有 ResizeObserver，故判空。
    const panel = panelRef.current
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined' && panel !== null) {
      observer = new ResizeObserver(place)
      observer.observe(panel)
    }
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, anchorRef, panelRef, side, align, gap, margin])

  return position
}

/**
 * 指针落在浮层之外时关闭它。
 *
 * `portal` 算「内部」：面板被 portal 到 `document.body`，并不是 root 的后代，
 * 否则点在面板自己身上也会被当成「外部」从而关掉用户正在用的浮层。
 */
export function useDismissOnOutsidePointer(
  root: RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
  portal?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return undefined
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node
        && root.current?.contains(event.target) !== true
        && portal?.current?.contains(event.target) !== true) {
        setOpen(false)
      }
    }
    // 用 `pointerdown` 而不是 `click`：按下即关闭才像外壳自身的行为，且它发生
    // 在下层元素被点击处理之前。
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [root, open, setOpen, portal])
}
