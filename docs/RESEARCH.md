# Trae 签到接口与其他积分奖励机制调研（dsh-connect-trae-models 积分自动化模块输入）

> 调研时间：2026-10-11。
> 证据来源：① 本地实测基准 `dsh-connect-trae/docs/USAGE_API_RESEARCH.md`（2026-08~09 真机实测）；② 本次联网核对（官方定价页 www.trae.cn/pricing、官方文档 docs.trae.cn、官方社区 forum.trae.cn）。
> 红线：仅记录已验证的接口路径与响应字段；无法核验的条目一律标注不确定，未编造任何路径或字段。

## 0. 证据等级约定

| 标记 | 含义 |
|---|---|
| [已验证·实测] | dsh-connect-trae 真机实测过（有请求/响应证据） |
| [已验证·官方文档] | Trae 官方文档 / 官网页面 2026-10-11 在线核对 |
| [已验证·社区] | 官方社区多帖互证的行为描述，无官方文档背书 |
| [未验证/仅推测] | 无法核验，禁止作为实现依据 |

## 1. 已验证接口（含请求要点）[已验证·实测]

Host 统一为 `https://api.trae.cn`；认证 `Authorization: Cloud-IDE-JWT <access_token>`（桌面 solo edition 的 `Cloud-IDE-JWT`，与网页 Cookie 是两套体系）；通用头 `Origin/Referer: https://www.trae.cn/` + 桌面 UA 均可。

### 1.1 每日签到状态（只读）

`POST /trae/api/v2/ug/checkin_credits/status`（body 可为空）

返回关键字段：`checked_in`、`did_checked_in`、`credits`（基础奖励）、`extra_credits`（额外奖励）、`enable`（活动开关）、`code`。

- `checked_in` 是**账号级**：该账号今天的签到奖励包已存在（额度已到账）。
- `did_checked_in` 是**设备级**（按 `x-device-id` 请求头字符串值判定，无其他维度）：这台机器今天的签到名额已用掉。
- 本机实测两者数值可不同：`checked_in:true, did_checked_in:false`、`checked_in:false, did_checked_in:true` 都出现过。**「本机今天已签到」≠「当前账号今天已领取」**。
- 状态查询**不需要** `x-device-id`；带上会回传设备口径的 `did_checked_in`。

### 1.2 每日签到领取（唯一写操作）

`POST /trae/api/v2/ug/checkin_credits/claim`，body `{}`（官方客户端发 `{"req_source":1|2}`，实测该字段对结果无影响）。

**必须带 `x-device-id` 头**（官方客户端 `fb(headers)` 的 `guaranteedDeviceId` 会给每个 ug 请求补上）。`x-device-id` 取本机 `iCubeAuthInfo://icube-dc:<id>` 的数字后缀。

| 业务码（HTTP 恒 200，必须看 body.code） | 含义 |
|---|---|
| `0` | 成功，奖励到账 |
| `9004` | 缺 `x-device-id`（参数错误；"The submitted order parameters are incorrect..."） |
| `9095` | **该设备**今日已签到（"当前设备今日已经签到，请明日再来哦～"），未发放 |

- 上游按**北京自然日**幂等：同一日重复 claim 仍回 `code:0`，但额度逐字节不变，**不会重复发放**。幂等是上游行为、不是可依赖的保证，调用方仍须自行先读状态再领取。
- 上游对 `x-device-id` 值不做签名/绑定校验（未登记的值一律当作"没签过"）——协议层上"换号"即"新的一天"，但 dsh-connect-trae 已明确立场：**不实现伪造设备号**（违反活动规则 + deviceId 会进 `reportTea`/`icube_device_register_*` 埋点，"同账号×大量设备号"是风控最易识别的形态）。dsh-connect-trae-models 应沿用该立场。
- 9095 场景（多账号池核心限制）：同一台机器的同一个 `icube-dc` 设备号一天只能为**一个**账号签到。社区大量印证（"一台电脑只能签到一个账号"、"本设备今日已签到"）。此为上游活动规则本身，插件应如实展示，不得绕过。

### 1.3 积分/用量读取（只读）

`POST /trae/api/v2/pay/web_user_ent_usage`（body `{"require_usage":true}`；别名 `user_current_entitlement_list`）

- 顶层：`is_credits_billing`、`usage_summary{total_amount, consumed_amount, consumption_ratio}`、`user_entitlement_pack_list[]`。
- pack 内（到期提醒模块的关键字段）：`entitlement_base_info.end_time` 为**到期毫秒时间戳**、`quota.credits_limit` 为额度、`usage.credits_amount` 为该包剩余、`display_desc` 为来源名（如"每月登录赠送""签到奖励"）、`currency` 区分积分类型（实测：0=免费、1=通用/Work 专属按产品定）。
- 签到奖励包命名 `checkin_YYYYMMDD_...`，其 `start_time` 为 claim 成功那一刻。
- **消耗顺序**（[已验证·官方文档]）：优先消耗剩余有效期最短的积分；相同有效期下奖励积分优先于会员积分；仅调用内置模型消耗积分，自定义模型不消耗。

### 1.4 活动规则（只读）

`POST /trae/api/v2/ug/activity/info` → `commercial_activities[]`，`activity_type` 实测含：

- `checkin_credits`（面额 200，实测时点值）
- `new_user_credits`（2000 + 2000）
- `send_message_reward`（500）

面额为实测时点值，会随活动期变动（见 §2.1），**必须运行时读取，禁止写死**。

### 1.5 其它已验证只读接口

- `POST /trae/api/v2/pay/cn_credits_billing_status` → `{is_credits_billing, should_force_switch}`
- `POST /trae/api/v2/pay/web_user_pay_status` → `client_reminder` + `commercial_activities`（出现 `express_lottery`、`work_fission`、`new_user_credits`）
- `POST /trae/api/v2/pay/expired_ents` → `{expired_ent_list: []}`
- `POST /trae/api/v1/pay/query_user_usage_group_by_session` → HTTP 200 但 `total:0`，**消费明细拿不到**（已多参数组合试错，不要再试）。
- 国际版 `/trae/api/v2/ug/*` 全族 404（`growsg-normal.trae.ai` / `api-sg-central.trae.ai` / `api.trae.ai` 实测），`www.trae.ai` 回落 HTML。cn 区域判断后直接答 404，勿把上游 HTML 404 当网络故障。

## 2. 每日签到规则现状（联网调研）

### 2.1 奖励面额：随活动期频繁变动 [已验证·官方文档 + 社区]

官方文档《套餐与计费》（2026-10 在线核对）积分获取表：

| 途径 | 免费用户 | 会员用户 | 有效期 |
|---|---|---|---|
| 每日签到 | 100 积分/天 | 200 积分/天 | 31 个自然日 |
| 每月登录赠送 | 500 积分 | 500 积分 | 当前自然月（月底清零） |
| 新用户注册福利 | 一次性 4000 积分 | — | 31 个自然日 |
| 老用户升级福利 | 一次性 4000 积分 | 按原"速通"档 6000~180000 | 31 个自然日 |
| 邀请新用户 | 双方各 500 | 双方各 500 | 31 个自然日 |

历史轨迹（社区互证，证明面额不稳定）：
- 2026-07~08 早期：200/天（Work 专属积分）；
- 2026-09-04 官方公告（帖 179650）：改为"免费 150 / 付费 200"，签到积分变为通用积分（TRAE Code + Work 可用）；
- 2026-09-13 起出现"100+50"的发放（帖 181043）；
- 2026-09-29 起免费用户普遍降为 100/天（帖 182778、350662）；
- 本地实测（2026-09-24）当时为 200。

定价页另有一行"会员签到多得 3000 积分"（Lite/Pro/Pro+/Ultra 同值，Free 为"-"）。其与文档"每日 100/200"的换算关系页面未解释（100×30=3000 恰好匹配免费月累计，200×30=6000 不匹配）→ [未验证/仅推测]，两处官方口径不一致，**实现上以 `checkin_credits/status` 与 `activity/info` 运行时数值为准**。

### 2.2 连续签到 / extra_credits [已验证·实测，无连签机制]

- `checkin_credits/status` 返回**没有** streak / 连续签到字段；官方文档、定价页、社区均无"连续签到额外奖励表"。
- 实测发放模式为 `credits`（基础）+ `extra_credits`（额外），本机为 150 + 50；社区帖描述"200+50""100+50"同构。`extra_credits` 是**当日**随签到一并发放的额外奖励包，非连签累积，数值随活动变动。
- 论坛检索 `extra_credits` 关键词 0 命中 → 该字段无公开文档。

### 2.3 签到入口 [已验证·官方文档 + 社区]

官方 FAQ：客户端点头像 → 「签到」按钮。签到最初仅 TraeWork 桌面端（2026-08），2026-09-05 起 TraeCode 客户端也有入口；**网页端（dashboard）与手机 App 无签到入口**（社区帖 182962、306953，2026-10 仍无）。网页 dashboard 未登录态重定向到 Cookie 登录页，与 `Cloud-IDE-JWT` 是两套体系，插件无法代登录。

## 3. 其他积分机制逐项调研结论

| 机制 | activity_type / 来源 | 是否存在 | 能否 API 自动完成 | 证据等级 |
|---|---|---|---|---|
| 每日签到领取 | `checkin_credits` | ✅ | ✅ 可（claim 接口，§1.2） | [已验证·实测] |
| 新人注册福利 | `new_user_credits` | ✅（activity/info 返回 2000+2000） | ❌ 注册时一次性发放，无领取接口 | 规则[已验证·官方文档]，接口[未验证] |
| 发消息奖励 | `send_message_reward` | ✅（activity/info 返回 500） | ❌（见 §3.1） | 规则[已验证·实测]，触发方式[已验证·社区] |
| 每月登录赠送 | `monthly_bonus`（pack 名 `monthly_bonus_...`） | ✅（500/月） | 无需自动化：每月**首次登录自动到账** | [已验证·官方文档 + 社区] |
| 邀请裂变 | `solo_fission` | ✅ 活动期 2026-09-07~12-31 | ❌（见 §3.2） | 规则[已验证·官方文档]，接口[未验证] |
| 抽奖 | `express_lottery` | 仅出现在 web_user_pay_status | ❌ 接口未知（见 §3.3） | [未验证/仅推测] |
| 网页/dashboard 任务中心 | — | ❌ 不存在（见 §3.4） | — | [已验证·社区 + 实测] |

### 3.1 send_message_reward（发消息奖励）

- `activity/info` 返回该类型、面额 500 [已验证·实测]。
- 官方社区 TRAE宝 帖（346110）提及用户账上存在"**手机给电脑发消息成功**奖励"积分 → 触发方式是**真实的消息行为**（移动端发消息到桌面），不是可独立调用的"领取"接口 [已验证·社区]。
- 结论：**不可自动触发**。模拟该行为需真实发送模型消息（消耗积分 > 500 奖励值，得不偿失），且无已知 claim 端点。插件定位：只读展示活动规则与到账明细。

### 3.2 solo_fission（邀请裂变）

官方文档《TRAE "邀请新用户得积分"活动》[已验证·官方文档]：活动期 2026-09-07 ~ 2026-12-31（北京时间）；每完成一次有效邀请，**邀请人与被邀请人双方各得 500 通用积分**；单个邀请人活动期封顶 3500 积分；积分 31 天有效，实时到账，可在【用量管理-奖励积分-邀请奖励】查看。有效邀请 = 被邀请人经专属链接**首次注册**并**成功登录**。

结论：**不可自动完成**——核心步骤需要真实新用户注册登录，无任何"领取"接口。插件可做：展示邀请进度/已到账奖励包（通过 packs 与用量管理数据），并可提醒积分 31 天有效期。

### 3.3 express_lottery（抽奖）

仅在 `web_user_pay_status` 的 `commercial_activities` 中出现该 activity_type [已验证·实测（仅类型名）]；官方文档与社区均未检索到该活动的规则、入口或任何接口 → [未验证/仅推测]。`/activity/growth/lottery/*` 是 **WorkBuddy** 的端点，Trae 上无对应已验证路径，**不得移植**。插件不做任何实现，最多透传上游返回的活动名做展示。

### 3.4 网页/dashboard 端任务中心

Trae CN **没有**网页端任务/成长中心：签到仅客户端入口（§2.3），用量页数据全部走 `api.trae.cn/trae/api/v2/pay/*`（已全部复现），web bundle 的 API client 注入的也是 `Cloud-IDE-JWT`。`www.trae.cn/dashboard` 需要 Cookie 登录态、无法代用户登录 [已验证·实测]。因此"网页端任务中心"无自动化对象。

### 3.5 补充：非 API 途径的积分（不纳入自动化）

社区投稿活动（forum 征文/晒技巧，单次 500~5500 积分）、高校学生认证（认证领 2000）等属运营侧发放，到账后同样体现在 packs 里。插件可只读展示，但不存在也不应模拟其"参与"接口。

## 4. 与 WorkBuddy 签到及成长中心对比

参照 `dsh-workbuddy-xdpool/src/upstream.ts`（只读分析）。

### 4.1 签到协议对比（WorkBuddy 1342-1391 行 vs Trae）

| 维度 | Trae | WorkBuddy |
|---|---|---|
| 状态接口 | `POST api.trae.cn/trae/api/v2/ug/checkin_credits/status` | `POST {billingBase}/v2/billing/meter/checkin-activity-status`，body `{}` |
| 领取接口 | `POST .../checkin_credits/claim`，**必须** `x-device-id` 头 | `POST {billingBase}/v2/billing/meter/daily-checkin`，body `{}`，无设备头 |
| 状态字段 | `checked_in`（账号级）/ `did_checked_in`（设备级）两个独立口径 + `credits`/`extra_credits`/`enable` | `active` / `today_checked_in`（单口径）/ `streak_days` / `daily_credit` / `today_credit` / `is_streak_day` / `next_streak_day` / `streak_bonus_days` / `streak_bonus_credit` / `claim_button_text` |
| 连续签到 | 无连签机制 | 有：streak 天数、里程碑日（`is_streak_day`/`next_streak_day`）、连签加成（`streak_bonus_*`） |
| 业务拒绝 | HTTP 恒 200，看 body.code（0/9004/9095） | envelope `code !== 0` 即失败（`envelopeError`），同样需看业务码而非 HTTP |
| 幂等策略 | 上游按北京自然日幂等，重复 claim 回 0 但不重复发放 | 重复签到未见独立业务码；自动化侧靠"先读状态再领取"守卫 |
| 错误语义 | 9095 = 设备名额已用（多账号核心约束） | 无设备名额概念，多账号可各自签到 |

### 4.2 成长中心自动化对比（WorkBuddy `/activity/growth/*` vs Trae 无对应物）

WorkBuddy 有一整套成长中心，Trae 完全没有对应端点族：

- **任务中心**：`GET {chatBase}/v2/activity/growth/tasks`（data.tasks[]，`claimable` 本地推导）+ `POST /v2/activity/growth/tasks/accept`（按 task_codes 报名，重复报名上游答成功）+ 任务奖励领取走 **web origin** `https://www.workbuddy.cn/activity/growth/tasks/{code}/claim`（需 `Origin/Referer` growth-center + `x-client-platform: web`；重复领取答 `already_claimed`、0 积分，视为成功保持幂等）。Trae：无任务列表/领取端点，签到之外无"任务"概念。
- **连登兑换**：`GET /activity/growth/streak`（注意**无** `/v2` 前缀，带前缀不 404 但 body 缺 `streak` 对象；计数在 `data.streak.days` 而非 `data.days`）→ `POST /activity/growth/redeem`（tier + `client_token` 幂等键；锁定档 403）。Trae：无连签、无兑换。
- **抽奖/宠物/补签/热力图**：`/activity/growth/lottery/summary|draw`、`/activity/growth/buddy/*`（info/agreement/first/travel 三态）、`/activity/growth/heatmap`、`/activity/growth/makeup-cards/use`。Trae：均无。
- **活动上报**：WorkBuddy 任务进度靠真实活动点亮——`POST {chatBase}/v2/report`（desktop 指纹事件**数组**，`userId` 缺失会 200 但静默丢弃、streak 不动，必须用 streak 只读回验）与 `POST https://www.workbuddy.cn/v2/report`（web 指纹，`x-client-platform: web`，`Library_read` 类页面行为任务约 4 秒后计分）。Trae：无成长体系上报，签到进度只由 claim 驱动。

**协议差异总结**：
1. **域与鉴权形态**：Trae 单网关（api.trae.cn）+ `Cloud-IDE-JWT` + 设备头（仅 claim 需要）；WorkBuddy 三类 base（billing host / chat host / web origin）+ Bearer token + 多套客户端指纹头，任务领取必须伪装成 web 来源。
2. **状态语义**：Trae 双口径（账号 vs 设备）但无 streak；WorkBuddy 单口径但带 streak/里程碑/加成。
3. **幂等设计**：Trae 依赖北京自然日幂等 + 9095 业务码；WorkBuddy 依赖 `already_claimed` 容错与 `client_token` 幂等键。
4. **自动化深度**：WorkBuddy 是"签到+上报+任务+连登+抽奖+宠物"全生态调度（scheduler.ts 五类 job：checkin/report/tasks/streak/travel）；Trae 的自动化面**收敛为单一签到 claim**，其余皆只读。

## 5. 对 dsh-connect-trae-models 自动化调度器的建议

### 5.1 可自动执行（写操作，仅一项）

**每日签到 claim**——`checkin_credits/claim`。执行契约：
1. 先 `POST status` 读状态；`enable:false` → 跳过（不报错）；`checked_in:true` → 已领，跳过且**不发 claim**。
2. `did_checked_in && !checked_in` → 本机设备名额已被占用，**不发 claim**，状态标记"本机今日签到已用（当前账号未获得）"，不得说成"已领取"。
3. claim 必带 `x-device-id`（来源同 dsh-connect-trae `identity.ts`：`icube-dc` 数字后缀；读不到时降级不发该头并跳过 claim，9004 即此配置缺失）。
4. 响应按 body.code 判定：`0`=成功；`9095`=设备名额已用（窗口间竞争，状态读完才被占用）→ 按"设备已签"展示，不当失败；`9004`→配置错误提示。HTTP 状态不可作为成功判据。
5. **多账号池的关键约束**：同机同 `icube-dc` 号一天只能为一个账号签到；第二个及之后的账号必然 9095。这是上游活动规则，调度器应如实呈现"1 个账号可领 / N-1 个设备受限"，**禁止**伪造/轮换设备号（合规 + 风控双重理由，见 §1.2）。

### 5.2 只读展示（不写账号状态）

- 积分总览与各包用量（`web_user_ent_usage`：`usage_summary` + packs 的 `usage.credits_amount`）。
- **模型/积分包到期提醒**（本任务组的另一模块）：遍历 packs 读 `entitlement_base_info.end_time`（毫秒）做倒计时；注意"每月登录赠送"自然月月底清零、"每日签到/新用户福利"发放日起 31 天、增购积分 31 天 [已验证·官方文档]。
- 消耗顺序提示：优先到期最短、同到期奖励积分先于会员积分。
- 活动规则面板：`activity/info` 的 `commercial_activities`（checkin_credits 面额、new_user_credits、send_message_reward）动态渲染，不写死数值。
- 邀请裂变进度（若上游 packs 出现"邀请奖励"包则展示到账明细）。

### 5.3 不可自动、仅提醒或展示

| 项 | 原因 |
|---|---|
| `new_user_credits` 新人福利 | 注册时一次性发放，无领取接口；只能展示已到账情况 |
| `send_message_reward` | 触发 = 真实发送消息（消耗积分 > 奖励），无 claim 端点；只展示 |
| `solo_fission` 邀请裂变 | 需真实新用户注册登录，不可代完成；可展示活动规则/封顶 3500/31 天有效期 |
| `express_lottery` | 接口完全未知，禁止编造路径；仅当上游活动列表出现时透传名称 |
| 网页端任务中心 | 不存在该产品面 |
| monthly_bonus | 登录自动到账，无需动作；仅在月底清零前做到期提醒 |

### 5.4 调度时序与可靠性建议

1. **北京自然日翻转后执行**：上游按北京日幂等判定，调度以 Asia/Shanghai 0 点为界；建议 0 点后执行并配置错峰重试（社区多次出现"操作频繁/闪断"，参考 WorkBuddy scheduler 的 `AUTOMATION_TICK_MS` 轮询 + 分时段 hours 设计）。
2. **幂等守卫分层**：本地守卫（今日已领则不发请求）+ 上游幂等兜底（重复 claim 无害但不重复发放），两层都要。
3. **9095/9004 与网络错误分型**：9095 是业务正常态（多账号预期），9004 是配置缺陷，网络/5xx 才值得重试；不要把 200 + 业务拒绝当 500。
4. **多账号串行 + 每账号独立 status 判定**：账号间不要共享"今天签没签"的本地缓存结论（账号级与设备级是两个独立事实）。
5. **面额零硬编码**：所有数值（签到面额、活动奖励）从 status/activity/info 运行时读取；官方口径 2026 年内已四次变动（200→150/200→100+50→100）。
6. **区域守卫**：非 cn 账号直接对签到路由答 404/禁用，不请求 `/ug/*`。
7. **不实现的功能（明确排除）**：设备号伪造/轮换、成长中心式事件上报模拟（Trae 无此体系）、消费明细表（上游返回空）。

## 6. 引用来源

- 本地实测：`D:/ClaudeCode/deepseek-harness/plugins/dsh-connect-trae/docs/USAGE_API_RESEARCH.md`（接口路径、字段、业务码、幂等、设备口径全部来源）
- 本地参照：`D:/ClaudeCode/deepseek-harness/plugins/dsh-workbuddy-xdpool/src/upstream.ts`（签到 1342-1391、成长中心 /activity/growth/*、/v2/report、任务领取 2017-2054）、`src/scheduler.ts`（五类自动化 job 与事件链）
- 官方文档（2026-10-11 核对）：docs.trae.cn《套餐与计费》（积分类型/获取途径/消耗顺序/签到 FAQ）、《TRAE "邀请新用户得积分"活动》
- 官方定价页：www.trae.cn/pricing（套餐积分与"签到多得 3000"行）
- 官方社区检索（forum.trae.cn/search.json，2026-10-11）：签到面额变更帖 179650/181043/182778/350662、设备名额帖 173038/305291、send_message_reward 到账帖 346110、monthly_bonus 到账帖 315074/178806/354635、网页端无签到入口帖 182962/306953、自动签到实践帖 180147/182888/183186
- 检索未见证据（负结果）：论坛 `extra_credits`、`send_message_reward` 关键词 0 命中；express_lottery 无任何公开规则
