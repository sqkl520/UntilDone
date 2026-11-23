# ADR-0005：Stop hook 验的是「说过的检查做了没有」，不是「活儿做完了没有」

- **状态**：已接受（2026-11-24）
- **决策者**：用户（要求「如实说它是什么，不是含糊地让它看起来像做到了」）
- **相关**：ADR-0002（诚实的降级）、ADR-0001（纯配置库）、`tasks/accepted-deviations.md` AD-009 / AD-010 / AD-011
- **取代**：`README.md`「收工前对上证据」那条**含糊的**能力描述，以及 `docs/CAPABILITIES.md` §3 只写「怎么开」的小节
- **证据**：本文所有数字出自 2026-11-24 对 `tasks/runs/stop-hook/` + `%LOCALAPPDATA%/Overwatch/stop-hook/` 的复算（412 条判定记录，2026-11-11 → 11-23，10 个台账文件）

---

## 1. 问题：文档按「它证明做完了」宣传，代码实现的是「它证明验证过了」

`stop-verify-hook.mjs` 读本轮最后一条 assistant 文本，抽出**完成性断言**，
再回 transcript 找**支持那句话的工具调用**。三档拦（`NO_EVIDENCE` / `STALE_ONLY` / `FAILED_ONLY`），
三档放（`SUPPORTED` / `UNKNOWN` / `UNCHECKABLE`）。

它管的是 **「你说过要验证的话，验证了没有」**。而 README 写的是
「收工前对上证据 —— 说完『做完了』，Stop hook 去 transcript 里找支持这句话的工具调用」，
读起来像「它能判断你做完没有」。**这两件事差别很大。**

三条 finding 指向同一个洞（DF-056 / DF-057 / DF-058）：

| finding | 说的是 |
|---|---|
| DF-056 | 台账 8 条 `action:"block"` 里，真实项目真实会话的真实拦截是 **0** |
| DF-057 | `no-checkable-claim` 占大头 —— 门对「诚实地停下」**零杠杆** |
| DF-058 | 验证白名单靠**脚本名**判断，空 `exit 0` 脚本能骗过；空输出也算通过 |

## 2. 实测：它到底是哪个

规模：**412 条**判定记录，覆盖 2026-11-11 → 11-23。

### 2.1 按 `allowReason` 分组（全量）

| `allowReason` | 条数 | 占全量 |
|---|---|---|
| `unparsable-input` | **214** | 51.9% |
| `no-checkable-claim` | **154** | 37.4% |
| `background-tasks-running` | 26 | 6.3% |
| `all-claims-supported` | 8 | 1.9% |
| `null`（就是 `action:"block"` 的那些） | 8 | 1.9% |
| `stop-hook-active` | 2 | 0.5% |

`unparsable-input` 全是 2026-11-11 → 11-18 的**老格式**（`bytes` 字段为 0 或 13），
之后的记录都能解析。**用全量当分母会把这个数说小** —— 154/412 = 37.4% 是被 214 条垃圾稀释过的。
**能解析的 198 条**里，`no-checkable-claim` 是 **154 = 77.8%**。本文一律用 198 当分母。

### 2.2 8 条 `action:"block"` 逐条拆

| 细分 | 条数 | 真拦截？ |
|---|---|---|
| `mode:"off"` 的观察记录（宿主没收到 block） | **6** | ❌ |
| `mode:"block"` + `outcome:"blocked"` + 合成会话 ID | **1**（`live-probe-2`） | ❌ |
| `mode:"block"` + `outcome:"blocked"` + 真 UUID 会话 | **1** | ⚠️ 落在 e2e 沙箱 |

**真实项目、真实会话上的真实拦截 = 0。**

那唯一一条真 UUID 是 `106aa1ae-4070-4d81-97e0-ff057613dc0a`（2026-11-14，抓「三个 bug 都修好了」）。
它的 transcript 在 `…/.claude/projects/C--Users-Administrator-AppData-Local-Temp-hook-e2e-sandboxes-PC3-proj/`
下 —— 是**端到端测试的沙箱**，不是用户项目。而且它之后**零条后续记录**：
**没有「拦完之后补了验证再过」的闭环案例。**

### 2.3 唯一的真实主机会话

`ea4ef562-…`（D 盘本仓库，2026-11-18 → 11-23，87 条判定）：全部 `allow`。
`no-checkable-claim` 54 / `background-tasks-running` 26 / `all-claims-supported` 7。
其中 33 条确实有可核对断言，**0 条被拦**。

### 2.4 结论

> **它验的是前者（说过的检查做没做），不是后者（活儿做没做完）。**
> 而且在前者这个维度上，它在真实项目上的实测拦截次数也是 **0** ——
> 因为 77.8% 的收工回合根本没有可核对的完成性断言（多半是正常收尾与诚实汇报）。

## 3. 决定

### 3.1 如实说它是什么（本文 + README「边界二」+ CAPABILITIES §3）

不叫「降级」—— 降级暗示「本来能做到、退而求其次」。**它本来就做不到「验活儿」。**
那需要一个能读需求清单并判断完成度的判据，而 N 个 bug 具体是哪 N 个、
「做一半」和「做完了」的边界在哪，都不在 transcript 里。

### 3.2 修 DF-058 中**可修**的那一半（2026-11-24）

| 形态 | 修前 | 修后 |
|---|---|---|
| 空 `exit 0` 脚本 +「三个 bug 都修好了」 | `allow, all-claims-supported` | **拦**（`NO_EVIDENCE`，并点名那条命令） |
| 宿主占位 `(Bash completed with no output)` | 当成有输出、通过 | 与空串**同判**为静默 |
| `grep foo check-x.mjs`（只读，靠文件名冒充验证） | 算验证 | **不算**（只读否决） |

**防误伤的另一半同样必须存在**：`node --check` / `tsc --noEmit` / `eslint`
按设计就静默（通过时零输出），把它们判成「什么都没打印」会让几乎所有 JS/TS 会话被误拦。
所以「静默」只在**必须打印点什么**的族里（`test-count` / `build` / `vague-completion`）
被当成「分不清」并拦截；commit / push / 文件改动保持原行为（`git commit -q` 本来就静默）。

实测代价（250 份真实 transcript / 2207 次判为验证的调用）：只读否决只翻掉 **9 次（0.41%）**，
逐条看过全是真的只读。

### 3.3 不修的部分

见 AD-009 / AD-010 / AD-011。核心是：**「验不了活儿做没做完」不修**，
因为修它需要的东西不在这条链路上。

## 4. 反悔信号

出现下列任一可观测证据时，**必须重新评估这个定位**：

| # | 可观测信号 | 怎么观测 | 为什么它意味着该重评 |
|---|---|---|---|
| 1 | 真实项目（非沙箱、真 UUID）上出现 ≥1 次 `mode:"block"` + `outcome:"blocked"`，且同会话后续出现 `all-claims-supported` | 台账按 `sessionId` 分组，看「拦后是否补齐」 | 那就出现了本 ADR 说「没有」的闭环案例，「零杠杆」的结论要改 |
| 2 | `no-checkable-claim` 占能解析记录的占比降到 50% 以下 | 同一段复算命令，分母改 198 | 说明触发条件变多了，闸门覆盖面变了，「对多数收工无触发条件」这句话失效 |
| 3 | 出现「需求做了一半、但每句完成声明都配了测试输出」的真实事故 | 人工报告 / 用户投诉 | 那正是本 ADR 声称管不了的那一类；它发生了说明「只管验证」的定位代价是真的 |
| 4 | 宿主开始为「诚实地停下」提供结构化信号（如 `end_turn` 带原因） | 宿主版本变化 + transcript 观察 | 「对诚实停下零杠杆」这一条**可能**因此可修 |

**反悔不等于回去把它宣传成「保证做完了」。** 即便上面 1 发生，它验的仍然是
「那句话有没有证据」，不是「需求完成度」。

## 5. 实现与复算

- 门：`scripts/stop-verify-hook.mjs`；判据：`scripts/verify-claims.mjs`
- 测试：`scripts/verify-claims.test.mjs`（DF-058 的 10 条用例，含两条负向）；
  **这 190 条里有 1 条曾把缺陷本身钉成「本批未修」，本次翻转**
- 复算：按 `sessionId` 分组统计 `tasks/runs/stop-hook/*.jsonl` 与
  `%LOCALAPPDATA%/Overwatch/stop-hook/*.jsonl`；注意 `%LOCALAPPDATA%/UntilDone/` 在本机**不存在**
  （改名迁移只对新写入生效，历史记录留在 `Overwatch/`）
- 引用数字时必须连同「412 / 198 / 88」三个分母一起引，否则会被 214 条老格式垃圾稀释
