# Seed-2.1-Pro-0915「插件长时间无响应、Trae 原生很快」根因分析与修复报告

> 取证/修复日期：2026-10-13　调试会话：`seed-model-hang`
> 影响版本：dsh-connect-trae-models 0.1.0（修复前）　验证环境：Windows + Trae CN 2.3.91（2 个 CN 账号）+ dsh 0.2.0-rc.2

## 1. 结论（TL;DR）

根因不是单一 bug，而是「**上游容量差异 + 三个本地缺陷叠加**」：

| # | 根因 | 性质 | 证据 |
|---|------|------|------|
| R1 | Seed-2.1-Pro-0915 在插件使用的 **SOLO 通道（`llm_utils_chat`）晚高峰排队 300+ 位、等待 6~10 分钟**；Trae 原生对话走 **`create_agent_task` 独立容量面**，所以快 | 上游容量面差异，非网络/鉴权 | 对照 glm-5.2 同通道 1.1s 首字；Seed 全 function 一致排队 |
| R2 | 桥接层对 `request_wait_in_queue`/`progress_notice` **不转发任何字节**，客户端全程死寂；pi-ai 的 300s 流空闲超时（只认真实 delta 事件）随后把请求杀掉 | 插件缺陷（直接体感） | 代码 + 真实栈复现 |
| R3 | 请求路径**从不回放目录的 wire 归属**：所有模型恒发 `function=solo_work_lite`、config_name 用显示 id（目录已算好 `wireFunction`/`wireConfigName` 却无人消费；移植自 dsh-connect-trae 时漏掉 `TraeSoloBridge` 解析层） | 插件缺陷（正确性，部分模型会 4001/4011） | 代码比对 + 目录取证 |
| R4 | 首字节超时用了无法解除的 `AbortSignal.timeout()`，对 signal 做 `clearTimeout` 是空操作——**任何超过 15 秒的流（含排队）都会被拦腰 abort** | 插件缺陷（修复期 E2E 新发现） | 修复前真实栈 15s 整 `TimeoutError` |

修复后 dsh web 端到端实测：豆包 2.1 Pro **15 秒**返回「豆包你好」，第二次 300 字问答秒回；322 个单测全绿。

## 2. 请求全链路（修复前）

```
DSH Composer → pi-ai(openai-completions) → http://127.0.0.1 随机端口 shim
  → TraeUpstreamClient.chatStream
      prepareSoloBody(body, …, undefined)   ← function 恒为 solo_work_lite（R3）
      postSoloChat（15s AbortSignal.timeout，响应头后未真正解除 → R4）
  → https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat
  ← 200 + progress_notice / queue_begin / request_wait_in_queue(position≈300) …（数分钟）… output
  → bridgeTraeSoloStream：queue/progress 事件被静默丢弃（R2）→ 客户端零字节
  → pi-ai idle watchdog 300s 杀流（R2）
```

Trae 原生（renderer 日志 2026-10-13 09:35 + ai_agent.dll 字符串取证）：
ai-chat v2 仅在 `solo_agent` agent 下可解析该模型，对话链路为
`api/agent/v3/create_agent_task`（配套 commit_toolcall_result/interrupt/resume，有状态任务协议），
与 SOLO 轻量通道是两套容量面。

## 3. 关键运行时证据

| 探针 | 结果 |
|------|------|
| Phase A 目录（零消耗） | wire/remote id 均为 `Doubao-Seed-2.1-Pro`（同名）；显示名 `Seed-2.1-Pro-0915`；归属 `solo_work_remote`；reasoning low/high；256K/Max 1M |
| Phase B ×6 function | solo_work_lite / solo_work_remote / solo_agent_remote / chat_v3 / solo_agent（含 reasoning_effort）**全部** 2~3s 回 200 后进入排队，25s 零正文 |
| Phase C 对照 | glm-5.2 **+1143ms 首 delta**，`queue_timing=4ms`；Seed 位置 145/153，100s 仅爬至 54/95 |
| Phase D 长等 | 位置 328 起，成批消化，6 分钟未排完；连接全程健康 |
| 修复前真实栈（shim） | Seed 流在 **15.0s 整**被 `TimeoutError` abort（R4 实锤） |
| 修复后真实栈（shim） | 排队位置帧 **+287ms** 到达客户端；45s 内 44 帧位置 + 2 帧心跳，干净退出；2×glm 并发 1.0~1.6s 首字互不阻塞 |
| dsh web E2E | 豆包 2.1 Pro 回答「豆包你好」**用时 15 秒**；第二次 296 字问答数秒完成 |

## 4. 修复内容

| 文件 | 修改 |
|------|------|
| `src/shim.ts` | 新增 `stampTraeWireTarget()`：请求前按目录改写 `model`→wireConfigName、盖 `function`→wireFunction、修剪未宣告的 `reasoning_effort`；主循环与上下文超限重试路径统一使用；成功流记录一次排队位置日志 |
| `src/solo-bridge.ts` | `request_wait_in_queue`→`: trae-queue position=N`、`progress_notice`→限流 `: trae-processing`；20s 兜底 `: trae-heartbeat`（背压时跳过、结束即清定时器）；90s **上游完全静默**保护，哑连接即时可读错误中止 |
| `src/upstream.ts` | 首字节超时改为「响应头后可解除」的 AbortController + setTimeout（修 R4）；`chatStream/chatPrepared` 增加 `labelModel`，SSE chunk 标签保留 DSH 请求的显示 id；修正历史误判注释 |
| `src/adapter.ts` | pi-ai `streamIdleTimeoutMs` 300s→**900s**（覆盖实测 6~10 分钟排队；注释说明边界与静默保护的分工） |
| 测试 | +8 个用例：排队注释帧不污染正文、wire 盖章（4 分支）、shim 端到端盖章+标签、响应头后慢 body 不被首字节超时误杀。共 **322 通过** |

设计要点：SSE 注释帧（`: …\n\n`）是规范内保活载体，OpenAI 消费方忽略，不改变消息内容；
排队是**模型级容量**而非账号/function 问题（实测换号排同一条队），不触发 failover。

## 5. 方案评估与选择

| 方案 | 性能 | 稳定性 | 维护成本 | 结论 |
|------|------|--------|----------|------|
| A. 逆向接入 `create_agent_task` 通道（原生同面容量） | ★★★ 理论同原生 | ✗ 协议未解（`ideagent.UserInput` 结构未还原）、有状态任务语义与本地工具循环不匹配、需双向适配 | 极高 | 长期方向，非本次最小修复 |
| B. 保活/排队可见 + wire 回放 + 超时修正（**已实施**） | ★★ 非高峰期秒回；高峰期可等到结果而非假死/被杀 | ★★★ 全部缺陷有回归测试，静默保护兜底哑连接 | 低，全部局部修改 | **采用** |
| C. 仅加大超时 | ★ 依旧全程死寂、用户无法判断状态 | ✗ 哑连接被放大；R3 未修 | 极低 | 否决 |

## 6. 测试报告摘要

- 单测：`pnpm typecheck` 通过；`pnpm test` **13 文件 / 322 用例全绿**；`pnpm build` 通过。
- 真实链路（本机 2 个真实 CN 账号，最小 prompt 消耗）：
  - 正常：glm-5.2 对照 ~1.1s 首字；修复后 Seed 在容量恢复时 dsh web 15s 完成问答。
  - 并发：同栈 2×glm + 1×Seed 并行，glm 1.0~1.6s 首字，Seed 排队帧持续，互不阻塞。
  - 异常边界：单测覆盖错误 bearer/非回环 Host/415/401/429 换号/静默保护/首字节超时/客户端取消；真实栈排队 45s 后探针主动中止，服务端无错误日志。

## 7. 已知边界与后续

1. **高峰期绝对等待时间无法在 SOLO 通道消除**——队列在 Trae 服务端；本修复把「假死 + 误杀」变为「可见、可等、可成功」。要完全对齐原生速度，后续需评估 `create_agent_task` 通道适配（参考 dsh-connect-trae/docs/DS41_CALLABILITY.md 的取证卡点）。
2. 排队位置当前以 SSE 注释形式对网络/日志可见；pi-ai openai-completions 不产出无内容事件，UI 暂无「排队中 N 位」气泡，需要上游 SDK 支持进度事件后再做可视化。
3. 15 分钟为单次排队总等待上限（pi-ai idle）；90 秒无任何上游事件即判哑连接并报错。
