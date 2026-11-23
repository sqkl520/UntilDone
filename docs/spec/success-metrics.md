# 走量的成功指标

> 本文件把「走量是否真的更省心」定义成**可计算**的东西。它不描述产品体验，
> 只回答一件事：**这五个数今天能不能算出来，数据在哪一行，缺的那一行要加在哪。**
>
> 每个指标分三档标注，**不允许含糊过去**：
>
> | 标注 | 含义 |
> |---|---|
> | **可算** | 现有数据源里有全部字段，写一个读取器就能算 |
> | **部分可算** | 有字段但定义或分母有缺口，必须连同缺口一起报 |
> | **不可算** | 缺一条**现在不存在**的记录，给出加在哪，**本轮不实现** |
>
> 判断依据全部是读源码得来的，不是推测。行号会漂，引用时以函数名为准。

## 0. 现有数据源到底记了什么（先核实，再定义）

| 数据源 | 落点 | 一条记录长什么样（实测字段） | 谁写 |
|---|---|---|---|
| 派发记录 | `prompts.jsonl`（`compose-agent-prompt.mjs` 的 `makePromptRow`） | `v` / `ts` / `kind:"prompt"` / `run` / `task` / `role` / `hash` / `bytes` / `ok` | `compose` 落文件时追加 |
| 产出台账 | `claims.jsonl`（`claim-ledger.mjs` 的 `makeExpect` / `makeClaim` / `makeObserve` / `makeConsume`） | `kind` ∈ `expect`（`paths` / `role` / `nonce` / `timeoutMin`）、`claim`（`path` / `agent` / `source` / `bytes` / `mtimeMs` / `sha256`）、`observe`（`path` / `agent` / `source` = `write-tool`\|`bash` / `failed`）、`consume`（`path` / `by`） | 主线程 `declare` / `consume`，子 agent `claim`，主线程 `observe` |
| 拆解图 | `tasks/runs/<run>/task-graph.json` | `subtrees[]` 的 `id` / `goal` / `capability` / `shape` / `token_budget_pct` / `timeout_min` / `acceptance[]` / `outputs[]` / `why_this_layer` | `oversight-planner`，`validate-run.mjs` 校验 |
| 会话 transcript | `~/.claude/projects/<project>/<session>.jsonl`，子 agent 在 `<session>/subagents/agent-*.jsonl`（含 `subagents/workflows/wf_*/`） | 每条 assistant 记录带 `message.usage`（`input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`）与 `message.id`；主 transcript 另有 `cost-state` 记录（`totalCostUSD` / `modelUsage`） | 宿主 |

**没有的东西，一并列清楚**（这是本文件大部分「不可算」的来源）：

| 缺什么 | 后果 |
|---|---|
| 任何一条记录带 `verdict`（通过 / 不通过 / 阻断） | 命中率、误放行率、终态成功率全部算不出来 |
| `prompts.jsonl` 里没有 `nonce`，也没有 attempt 序号 | 提示词台账无法与某一次尝试对齐（只能按 `task` 粗对） |
| `claims.jsonl` 的 `expect` 没有 `--session` 字段 | run → 会话目录的映射不落盘，只能靠 nonce 反查 |
| 任何地方都没有「失败位置」这一记录 | 定位准确率没有分子，也没有分母 |
| 任何地方都没有「下游又发现了问题」的回指 | 误放行率没有反向边 |

**当前样本量**（实测 `tasks/runs/`）：10 个 run 目录，其中 **1 个**有 `claims.jsonl`（11 行）、
**1 个**有 `prompts.jsonl`（1 行）、**2 个**有 `task-graph.json`。
另测：30 天窗口内非沙箱会话 **299** 份，其中真正用过 `Agent` 工具的 **216** 份（72.2%），
提到 `task-graph.json` 的 **3** 份（1%）（`node scripts/measure-checklist-coverage.mjs --days 30`）。

> **这条决定了下面每个指标的读法**：任何比率在 n≈1 的 run 上都只是描述，不是比率。
> 报数时必须同时报 `n`，否则「95.4%」这种数字是在拿一个样本冒充一个分布。

## 1. 每任务总调用次数与总 token 消耗

### 1.1 定义

对某个 `(run, task)`：

```
tokens_billable = Σ 去重后的 input_tokens + cache_creation_input_tokens + output_tokens
tokens_cache_read = Σ 去重后的 cache_read_input_tokens          （单列，不进上面那个数）
calls           = Σ 去重后的 tool_use 条数（按 tool_use.id 去重）
```

**去重键必须是 `message.id`**（token）与 `tool_use.id`（调用），不是记录行数。
这不是洁癖，是实测：同一次 API 响应会被拆成多条 assistant 记录，每条都重复带**同一份** `usage`。

实测（本机语料，20 份主 transcript 抽样）：

| 量 | 原始计数 | 去重后 | 膨胀倍数 |
|---|---|---|---|
| `usage` 四字段之和 | 226,073,509 | 47,904,179 | **4.72×** |
| assistant 记录数 / 不同 `message.id` | 1,881 | 517 | 3.64× |
| `tool_use` 块 / 不同 `tool_use.id` | 945 | 543 | 1.74× |

**为什么 `cache_read_input_tokens` 单列**：它每轮都把同一段上下文重新计一次。
把它加进「总 token」会让「多跑一轮」看起来比实际贵一个数量级，而它主要是缓存命中价。
两列都报，读者自己决定看哪个；**合成一个数才是错的**。

### 1.2 数据从哪来

| 部分 | 来源 | 状态 |
|---|---|---|
| 单个子 agent 的 token | 该 transcript 的 `message.usage`，按 `message.id` 去重 | **可算**（实测 400/400 份子 agent transcript 都有 `usage`） |
| 单个子 agent 的调用数 | 该 transcript 的 `tool_use` 块，按 `tool_use.id` 去重 | **可算** |
| 任务 → 子 agent transcript 的归属 | `claims.jsonl` 的 `expect.nonce` + transcript 首条 user 消息里的 nonce（`observe` 已经在这么做：`findNonce`） | **可算，但只在跑过 `declare --nonce` 且跑过 `observe` 的 run 上** |
| run 级总额（含主线程开销） | 无 | **部分可算**：主线程的 usage 有，但它没有「这条属于哪个任务」的标记 |
| 美元成本 | 主 transcript 的 `cost-state.totalCostUSD` | **部分可算**：只在主 transcript 上有（实测 1005 份主 transcript 里 755 份有，400 份子 agent 里 **0** 份有），且是会话级不是任务级 |

### 1.3 现在算不出来 / 算不准的部分

1. **`scan-sessions.mjs` 的 `calls` 字段不能直接用。** 它取自 `extractCalls()`，
   **不去重**，且只读尾部窗口，并且被 `MAX_CALLS_PER_SESSION = 400`、
   `MAX_SUBAGENTS = 100`、`SUBAGENT_READ_BYTES = 512 KiB` 三个上限截断。
   拿它当「总调用次数」会把「重复记录」算成「多干活」，同时在长会话上少算。
   → 正确做法是另写读取器（不在 `scan` 的判据面上改，那条链服务于状态判定）。
2. **任务级 token 只在有 nonce 归属时才成立。** 没有 nonce 就没有归属，
   而没有归属时任何「每任务 token」都是把整个会话摊到任务上 —— 那是一个**分配假设**，不是观测。
3. **run → 会话的映射不落盘**（`declare` 没有 `--session`）。计算 run 级总额要人工给一个会话目录。

### 1.4 要加的那一行（本轮不实现）

在 `claims.jsonl` 里增加一个 `kind:"usage"` 行，由**收活时**写入（`observe` 顺带即可，
它已经在读 transcript 了）：

```json
{"kind":"usage","run":"<run>","task":"<task>","agent":"<agentId>",
 "input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,
 "calls":0,"dedupe":"message.id"}
```

加它的唯一理由是**留痕**：transcript 会被清理，`tasks/runs/` 不会。
不加也能算，但要每次重扫 transcript（子 agent 文件实测 5.2 GB 量级）。

## 2. 盲重采样命中率

### 2.1 定义

> 盲重采样 = **丢弃失败输出**，从原始任务契约重新派发一个**全新实例**（新 nonce）。

对某个任务，第 `i` 次尝试的结局记 `r_i ∈ {PASS, FAILED, BLOCKED}`，则：

```
attempts_to_pass = min{ i : r_i == PASS }        （没有则记 censored，不记 0、不记 3）
hit_rate_1       = #{任务: r_1 == PASS} / #任务
hit_rate_k       = #{任务: attempts_to_pass ≤ k} / #任务      （k = 1, 2, 3）
mean_resamples   = mean(attempts_to_pass - 1)   （分母只含非 censored 的任务）
```

**必须在同一张表里报 `censored` 数**（3 次仍未过）。把它从分母里悄悄去掉，
会让「平均 1.2 次重采样就过」看起来比实际好 —— 因为最难的那些任务不在分母里。

### 2.2 数据从哪来

| 部分 | 来源 | 状态 |
|---|---|---|
| 尝试次数 | `claims.jsonl` 里该 `(run, task)` 的 **`expect` 行条数**（每次 `declare` 一行，nonce 不同） | **可算**（但要读**原始行**：`foldRows` 会把同一 task 的多条 `expect` 折叠成一条并只留最后一个 nonce） |
| 尝试次数的第二来源（交叉校验） | `prompts.jsonl` 里该 `(run, task)` 的 `prompt` 行条数（每次 `compose` 一行） | **可算**（`--dry-run` 不写行，实测） |
| 每次尝试的结局 `r_i` | 无 | **不可算** |
| 「这次是不是盲重采样（而不是局部修复）」 | 无 | **不可算** |

### 2.3 缺什么

**结局没有任何记录。** 全仓没有任何写入点产生「通过 / 不通过」：
`FAILING_VERDICTS` 里的值（`PARTIAL` / `MISSING` / `CONFLICT` …）是**产出对账**的结论，
不是验收结论；`delivery-verdict.mjs` 有 `deliverVerdict()` 但**零调用点**（见 DF-080）。

所以现在能算的只有**分母的一半**：每个任务试了几次。
「几次之后过了」里的「过了」没有数据。

### 2.4 要加的那一行（本轮不实现）

在 Phase E 每次验收之后追加一条：

```json
{"kind":"verdict","run":"<run>","task":"<task>","attempt":1,"nonce":"<该次派发的 nonce>",
 "by":"acceptor","verdict":"PASS","source":"<acceptor 返回文件或 transcript>",
 "reasons":[]}
```

- `attempt` 必须显式记，不能靠行的顺序推断 —— 台账是 append-only，但重试与补记会交错。
- `nonce` 必须记：它是把「这次尝试」与「这一次派发的产物」绑起来的唯一键。
- `by` 取 `acceptor` / `redteam` / `host`：验收、红队、宿主上报是三个不同的 oracle，不能合并成一个 `FAILED`。

**还要记「这次是盲重采样还是局部修复」**（`dispatch-contract.md` §8 的两条路径），否则
命中率会把两条路径混在一起 —— 而盲重采样的定义是「不给失败输出」，这件事在数据上
必须可见，不能靠主线程记得。

## 3. 修复路径的局部定位准确率

### 3.1 定义

```
localization_precision = #{定位点: 修复后该点上的失败复现消失} / #{定位点总数}
task_hit               = #{任务: 全部失败原因都有定位点且都命中} / #{进入局部修复的任务数}
```

分子要求的是**同一个失败复现**消失，不是「重新验收通过」——
后者可能由别处的改动顺带满足，而那就是下一节要抓的误放行。

### 3.2 数据从哪来

| 部分 | 来源 | 状态 |
|---|---|---|
| 定位点（`file:line`） | `dispatch-contract.md` §8.3 的 C1 要求 Hub 写出来 | **不可算**：C1 是**流程要求**，没有任何写入点把它落成数据 |
| 定位点是否在 `outputs` 内（C2） | `task-graph.json` 的 `subtrees[].outputs` + 定位点 | **可算**（一旦定位点被记录，子集判断是纯计算） |
| 「该点上的失败是否消失」 | 需要重跑失败的那条检查 | **不可算**：没有记录「失败复现是哪条命令」 |

### 3.3 缺什么，以及一个必须承认的边界

1. **「真的是失败位置」需要一个 oracle。** 最便宜且可判定的替代是：
   **重新执行当初判失败的那条检查命令，看它是否转绿**。这是**代理指标**，
   不是「真位置」——如果那条检查本身写错了，这个代理会把错误位置判成命中。
   报数时必须写清用的是代理，不能写成「定位准确率 87%」而不说口径。
2. **失败复现的命令没有任何记录。** 验收 Agent 的返回里有「证据引用」，但那是散文。
3. 该指标的分母**天然很小**：只有走 §8.3 B 路径（局部修复）的任务才进分母。
   按 §8.0 的默认策略，多数失败应走盲重采样 —— 所以这个指标的样本量会长期是个位数。
   这是**设计使然**，不是数据缺失；报数时应说明「分母 = 进入局部修复的任务数」，
   而不是拿全部任务当分母。

### 3.4 要加的那两行（本轮不实现）

```json
{"kind":"locator","run":"<run>","task":"<task>","attempt":2,"file":"<仓库相对路径>","line":40,
 "source":"acceptance|redteam|hub","in_outputs":true,
 "repro":"<一条能复现失败的命令>"}
{"kind":"localization","run":"<run>","task":"<task>","attempt":2,"file":"<仓库相对路径>","line":40,
 "repro_green_after_fix":true,"verified_by":"hub"}
```

`repro` 字段是这条指标能不能成立的关键：没有「失败复现命令」，
「修好了」就退化成自述。

## 4. 验收门 / 红队门的误放行率与误拦截率

### 4.1 定义

```
false_pass_rate  = #{PASS 之后被下游发现问题} / #{PASS 总数}
false_block_rate = #{判 FAIL 但产出未被改动就再次通过} / #{FAIL 总数}
```

两个都要**分子分母同表报**。只报误放行率会让「全部判 FAIL」看起来最优
（误放行 0%），所以这两个数必须成对出现。

### 4.2 误放行的数据从哪来

| 部分 | 来源 | 状态 |
|---|---|---|
| `PASS` 总数 | 无（同 §2.3） | **不可算** |
| 「下游发现了问题」 | `tasks/dev-findings.md` 的 DF 条目 / `docs/CHANGELOG.md` 里「修出来的回归」 | **不可算**：两者都不带 `run` / `task` / `nonce`，无法回到是哪次 PASS 放行的 |

**已有的两个真实样本**（说明这条指标不是假想）：
DF-076 是一次「修出来的回归」——上一轮修复让 `doctor` 在健康时 100% 说反话；
DF-077/078 是「规范声称深度 3 层」漂了 12 天。两者都是**当时通过了本仓流程**的交付。

### 4.3 误拦截的数据从哪来（这一条比误放行更接近可算）

判 `FAIL` 之后，如果**产出没被改动**就再次判 `PASS`，那么第一次 `FAIL` 是误拦截
（或者第二次 `PASS` 是误放行 —— 这条判据分不开两者，报数时必须说清这一点）。

「产出没被改动」是**可算**的：`claims.jsonl` 的 `claim` 行带 `sha256` + `bytes` + `mtimeMs`，
两次 `claim` 的 `sha256` 相同即「字节未变」（超过 4 MiB 时是截断比对，行上有 `hashTruncated`）。

所以缺的仍然只有**结局记录**（`verdict`），以及**改动前后两次 claim 的配对**。
后者可以由 `claim` 行的 `ts` + `path` 自然配对，不需要新字段。

### 4.4 要加的那一行

与 §2.4 同一行（`kind:"verdict"`）。**这两个指标共用一条记录**，不是两条 ——
验收结论只有一份，误放行与误拦截是它的两种错误方向。
另外建议在 `verdict` 行上加 `outputs_sha256`（该次尝试全部 `outputs` 的哈希串），
这样「没改动就再判一次」可以离线判定，不需要重扫 transcript。

### 4.5 不要和硬门混为一谈

`scripts/check-structure.mjs` 的 27 项检查也是「门」，但它的误放行率的度量方法是**变异测试**
（把 bug 放回去，门必须红），不是本节的口径。两者分母不同（一次提交 vs 一次派发），
**不能合成一个数**。本节的四个比率只适用于 `acceptor` / `redteam`。

## 5. 终态一次交付成功率 vs 经过门禁回流后的终态成功率

### 5.1 定义

```
first_pass = #{任务: 第 1 次尝试即 PASS 且无 block 级红队结论} / #任务
terminal   = #{任务: 存在某次尝试 r_i == PASS 且无 block}     / #任务
```

- 分母 `#任务` 的**准入条件必须先声明**：只算 `shape` 为 `artifact` 且 `outputs` 非空、
  且 `expect` 行存在的任务。`NO-EXPECTATION` / `EMPTY` 是**规划失败**，混进来会让
  「成功率」同时测量规划能力和工程能力，两个都测不准。
- `block` 级红队结论的口径来自 `delivery-verdict.mjs` 的 `RT_DISPATCH`：
  只有 `dispatch:"block"` 算阻断，`advisory` / `accept` 不算。
- 两个数**必须一起报**。只报 `terminal` 等于报「修了多少轮之后能过」，
  只报 `first_pass` 等于报「一次做对的比例」，任何一个单独出现都会被读成另一个。

### 5.2 关于 54.8% → 95.4% 这个参考数

外部公开数字（某多 Agent 编排系统）：一次交付 **54.8%**，经门禁回流后终态 **95.4%**。

三条必须写清的限制，否则这个数会被误用：

1. **它不是本仓的数据，也不是本仓的基线。** 本仓没有任何一次对照实验能产出这两个数
   （样本量不够，且任务由我们自己选）。引用它只能作为「这两个数应该成对出现」的提醒，
   不能写成「我们达到 95.4%」。
2. **任务分布不同不可比。** 那个系统的任务集与本仓的（配置库 + 零依赖脚本）不是同一个总体。
3. **95.4% 这个数本身有另一个含义需要排除**：本仓 `95.4%` 已经出现在
   `docs/research/2026-10-31-replay-observations.md` 等三处，指的是**在线停止分类
   `UNCLASSIFIABLE` 占比**，与本指标无关。同一个数字在仓库里指两件事，
   引用时必须带上下文，否则会被读成「同一件事两次被证实」。

### 5.3 数据从哪来

与 §2 完全同源：**只需要 `kind:"verdict"` 这一条记录**。有了它，§2 / §4 / §5 三个指标
同时成立 —— 这是本轮最重要的结论：**缺的是同一条记录，不是三件事。**

```
first_pass  = count(attempt=1 且 PASS 且 无 block) / count(进入分母的任务)
terminal    = count(存在 PASS 且 无 block)         / count(进入分母的任务)
```

## 6. 汇总：五个指标各自的状态

> **2026-11-23 更新**：本节原来全是**读源码得出的判断**。现在有了
> `scripts/compute-metrics.mjs`（DF-083），下列每一格都是**真跑出来的**。
> 判决没变（四个指标仍卡在同一条记录上），但多了三处**只有跑过才会知道的**事实：
> ① `expect.nonce` 归属在本仓 **0/3**（`observe` 自己跑也是 0/256）；
> ② transcript 里真的有 **7 条**可解析的验收结论（不是零），但**没有 `task` / `nonce`**，
>   只能拼出 2 条链（n=2）；
> ③ 7 条里有 **1 条链出现「通过后又判不通过」**，但它是**候选**不是证明（见 §4.2）。

| # | 指标 | 现在能算吗 | 缺的那一条记录 | 实测（2026-11-23） |
|---|---|---|---|---|
| 1 | 每任务总 token | **部分可算** | `kind:"usage"`（也为留痕） | 语料级可算：231,056,476 计费 token（去重后，454 份 transcript）；**任务级 0/3 归属** |
| 1 | 每任务总调用次数 | **部分可算** | 同上 | 语料级 55,656 次（按 `tool_use.id` 去重）；任务级同上 |
| 2 | 盲重采样命中率 | **不可算**（一半可算） | `kind:"verdict"` + `attempt` + `nonce` | 分母 3 expect / 1 prompt；transcript 口径 2 条链、平均重采样 2 次（**n=2，不可引用**） |
| 3 | 局部定位准确率 | **不可算** | `kind:"locator"` + `kind:"localization"`（含 `repro` 命令） | 只算出 C2 = 4/5、C1 机械部分 = 5/5 |
| 4 | 误放行率 | **不可算** | `kind:"verdict"` + 下游 DF 条目的回指 | 可解析 PASS 总数 = 7；85 条 DF 条目**零个**带 `run`/`task` |
| 4 | 误拦截率 | **不可算**（差结局） | `kind:"verdict"` + `outputs_sha256` | 「产出未变仍判过」的 sha 侧可算，但结局那一句没有落盘 |
| 5 | 一次成功 vs 终态成功 | **不可算** | `kind:"verdict"` | transcript 口径 first_pass 0/2 · terminal 2/2（**n=2**） |

一句话：**五个指标里，四个卡在同一条 `verdict` 记录上。** 这一条在 2026-11-23 之前是判断，
之后是实测 —— 而实测同时发现了另一条：**指标 1 的归属缺的可能不是 `usage` 记录，
而是 nonce 的落盘位置**（见下）。

### 6.1 一个必须先修的比 `verdict` 更早的洞：归属键在数据上读不到

`§1.2` 把「任务 → transcript」的归属挂在 `expect.nonce` + 首条 user 消息上。**实测 0/3**：
`claim-ledger observe` 自己跑也是 `0/256`。真因不是判据错，是**nonce 的位置**：

```
一个子 agent transcript 里，nonce 首次出现的字节偏移 = 288,185 / 文件 423,275 字节
（`findNonce(readHeadText(f))` 只读前 64 KiB，永远读不到）
```

它是子 agent 自己 `Read` 了 `claims.jsonl` 之后才被读进上下文的。所以要让归属成立，
**nonce 必须出现在派发 prompt 的正文里**（`compose --nonce` 已经支持，但实测本仓那个 run
的 3 个 nonce 没有一个进入了首条 user 消息）。这比 `kind:"verdict"` 更靠前：
没有归属，即使有了 `verdict` 也拼不成「这个任务的第 i 次尝试」。

## 7. 交叉校验：每条指标至少两个独立来源

单来源的指标会被「工具在数自己」污染（本仓已有先例：`measure-checklist-coverage.mjs`
的文件头写着「不排除沙箱会把派发率算成 90%+，那是测量工具在数自己」）。
所以每条指标在被引用前，必须能指出第二个来源：

| 指标 | 来源 A | 来源 B |
|---|---|---|
| 尝试次数 | `claims.jsonl` 的 `expect` 行数 | `prompts.jsonl` 的 `prompt` 行数 |
| 产出是否改动 | `claim.sha256` | `observe` 的 transcript 痕迹（`source` 区分 `write-tool` / `bash`） |
| 归属是否正确 | nonce（`claims.jsonl`） | transcript 首条 user 消息与父会话 `Agent` 调用的 `prompt` 逐字节相同 |
| 结局 | `acceptor` 的返回 | 宿主上报（`FAILED` / `BLOCKED`），只在两者冲突时成为发现 |

**两个来源不一致时，不许取其中一个当结论。** 不一致本身就是要报的那件事。

## 8. 本轮明确没做的

1. ~~没有实现任何读取器~~ **2026-11-23 已实现一个**：`scripts/compute-metrics.mjs`
   （+ `compute-metrics.test.mjs` 27 条）。它只读，不改 `scan-sessions` / `claim-ledger` / `compose` 一行。
   它实现了 §1（语料级）、§3 的 C1/C2 机械部分、§2/§4/§5 的**分母**与可解析结局的检测。
2. ~~没有加任何记录点~~ **仍未加**。上面所有的 `kind:"..."` 现在还是**提案** ——
   脚本会在输出的 `gap` 里逐个点名它们该加在哪，但**不打那一行**。
   理由记在 DF-083：加记录点要改 Phase E 的真实链路，而 Phase E 刚接上 `deliverVerdict()`
   （DF-080），两个改动叠在一起会分不清是谁的回归。
3. 没有用 54.8% / 95.4% 造任何「目标值」。本文件里它们只是参考坐标。
4. ~~没有测出任何真实比率~~ **测出了三个，全部标了样本量**：
   - 任务级 nonce 归属率 **0/3**；
   - C2（AC anchor ∈ outputs）**4/5**；
   - C1 机械部分（文件存在且行号可达）**5/5**。
   另有两组 `n=2` 的数（平均重采样 2 次、first_pass 0/2）—— **样本量不足以支撑结论**，
   报告里也这么标了。它们不是「比率」，是「这条链长这样」。

## 9. 怎么复算

```bash
node scripts/compute-metrics.mjs              # 全量（本机 454 份 transcript / 730 MB）
node scripts/compute-metrics.mjs --days 30    # 时间窗
node scripts/compute-metrics.mjs --json       # 机器可读
node scripts/compute-metrics.mjs --session <会话目录或 .jsonl>
```

三条读数的约定（脚本会打印，这里也写一遍，因为报告会被单独传阅）：
- **每个比率与它的 `n` 同表出现**，`n < 30` 一律标「样本量不足以支撑结论」；
- **算不出来返回 `null`，不返回 0** —— 0 会被下游当「比率 0%」引用；
- **去重键**：token = `message.id`，调用 = `tool_use.id`；`cache_read` 单列。
