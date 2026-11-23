# 证据纪律

> 本文件约束**所有产出 finding 的 Agent**。它不对抗「写得不够好」，对抗的是两种最常见的失效：**幻觉指控**与**谎报覆盖率**。

## 1. 四件套（缺一不合格）

每条 finding 必须同时具备：

| # | 要素 | 要求 |
|---|---|---|
| 1 | `file:line` | 精确到行；多处问题分开列 |
| 2 | **真实原文** | 引用，**不许转述**。转述会让读者无法判断你是不是编的 |
| 3 | 复现场景 | 具体操作序列 / 输入→错误结果 / 触发条件解剖 |
| 4 | 修法建议 | 1–3 句，具体到可执行动作 |

缺少任一项的 finding **不计入结论**，也不计入「已发现 N 个问题」的计数。

## 1.5 证据强度分层：弱证据不得替代强证据

> 实现：`scripts/delivery-verdict.mjs` 的 `EVIDENCE_KINDS` / `classifyEvidence()` / `deliverVerdict()`。
> 测试：`scripts/delivery-verdict.test.mjs`（39 条，每条都配回退断言）。

### 1.5.1 它治的是什么

一个正在被反复复现的伪完成模式：

> Agent 点完按钮，日志返回 `success`，测试也绿了，但**界面开关仍然没有变化**——
> 因为原测试只断言「调用没抛异常」，没有断言界面真实状态改变。

代码交付里的同一个病：**单测全绿、编译退出码 0，但交付物里全是 Mock 数据，核心路径没接上。**

根因一句话：**「调用成功」被当成了「操作成功」。**

### 1.5.2 强证据（可重放、独立于生成者）

| `kind` | 必须带什么才算强 | 为什么这条是「必须」 |
|---|---|---|
| `test` | `command`：一条**别人能照着跑**的命令 | 没有命令的「跑过测试」无法被复现，它就是一份自述 |
| `artifact` | `path` + `bytes`（真实字节数 > 0） | 「生成了文件」与「文件在那儿且有内容」是两件事；零字节的产物最容易被忽略 |
| `exit_code` | `exitCode`：真实数字 | 「命令没报错」不等于「退出码是 0」；两者在 CI 里完全不同 |
| `file_content` | `path` + `bytes` | 与 `artifact` 同理，用于「内容对不对」这一类断言 |

### 1.5.3 弱证据（不可重放、依赖生成者自述）

| `kind` | 是什么 | 能不能当判据 |
|---|---|---|
| `self_report` | 模型自述「我做完了」 | 不能 |
| `screenshot` | 截图式演示 | **只能作辅助**，不能作判据（见 §1.6） |
| `log_paste` | 没有环境信息的复制日志 | 不能（不知道在哪个 commit / 哪台机上跑的） |

### 1.5.4 「独立于生成者」的可判定形式

一条强证据必须满足 `producedBy !== subject`：产出这条证据的**生成器**，不能与被验的对象是同一个。

写成判据而不是口号，是因为「同一支笔不能既写答案又判对错」在自然语言里无法执行。
`classifyEvidence({ ... }, { subject })` 在 `producedBy === subject` 时把 `strong` 置为 `false`，
并给出理由 `自证不能当强证据`。

> 注意这条**不**要求「跨模型」。它要求的是「跨上下文」——见 §1.7 与
> `dispatch-contract.md` §3.1 的上下文隔离约束。同一个模型跑在两个互不可见的上下文里，
> 独立性就成立；同一个上下文里「再想一遍」不成立。

### 1.5.5 「关键路径」的可判定定义

**不是**「很重要的功能」，而是**派发前就声明好的一张路径清单**：

```yaml
criteria:
  keyPaths:
    - id: K1
      path: src/app/route.ts     # 仓库相对路径
      why: 用户点到的那个按钮
  requiredStrong:                # 每条关键路径上至少要有哪一类强证据
    - key_path: K1
      kinds: [test, artifact]
```

判据只有一条：**任何声称「这条属于关键路径」的裁定，都必须指向 `keyPaths` 里的某个 `id`。**

不在清单里的，不阻断交付（降级为 `advisory`），但**也不会被静默接受**：
`deliverVerdict()` 对「声称 key_path 但清单里没有」给出 `key_path_undeclared` 并判 `BLOCKED`。
理由与硬约束 4 同源：**事后声明关键路径，与事后编造验收标准是同一类错。**

### 1.5.6 「替代」的可判定定义

对某条已声明的关键路径 `K`，若 `requiredStrong` 要求 `kinds: [test, artifact]`，
而 `K` 上**没有任何一条**判定项带一强类型证据 —— 判 `BLOCKED`，码 `weak_replaces_strong`。

这就是**验收 PASS 的必要条件**的唯一机械形式：

> **关键路径上，弱证据不得替代强证据。**

为什么不是「每条判定项都要强证据」：判定项里天然有「不加依赖」这类纯判断，
对它们要求强证据会在合法交付上造一条永久的红 —— 而一条永远红的规则会被关掉。

### 1.5.7 这条规则自身「判不了」的边界（诚实申报）

以下三点**目前无法机械判定**，写在这里而不是藏起来：

1. **`keyPaths` 里的 `path` 是否真的覆盖了用户要走的那条路**。判据能核「声明过的路径上有强证据」，
   核不了「声明得全不全」。一个只声明了无关紧要路径的 `keyPaths` 能通过全部检查。
   *缓解*：`deliverVerdict` 把未声明的 `key_path` 判红，逼声明显式；但「该声明什么」仍需人判。
2. **一条 `test` 类的命令「是不是真的断言了业务状态改变」**。判据能核命令存在且可重放，
   核不了那条测试的断言写的是什么。这正是原始伪完成模式的最后一个缺口：
   `test` 类证据可以是 `expect(true).toBe(true)`。
   *缓解*：`dispatch-contract.md` §3.1 要求验收只看交付物、且**必须核对测试断言的对象**；
   但这条落到人话，不可自动判定。
3. **截图的真伪**。判据只能把它归为弱证据并拒绝它作为关键路径的唯一证据，核不了图里是什么。

## 1.6 GUI / 交互类交付的额外规则

> 本仓库当前的交付形态是**纯配置库 + 零依赖 Node 脚本**（`docs/adr/0003-application-not-plugin.md`），
> **没有 GUI 交付**。所以本节目前是**适用条件 + 判定方法**，不是对现有流程的约束。
> 什么时候它开始生效，见 §1.6.3。

### 1.6.1 必须区分的两件事

| 概念 | 表现 | 证据类型 |
|---|---|---|
| **动作调用成功** | 按钮点了、接口返回 200、`success` 日志 | 弱（`log_paste` / `self_report`） |
| **业务状态改变** | 开关真的变了、数据真的落库 | 强（`file_content` / `test` / `artifact`） |

**后者必须由独立于动作生成器的观察器判定。** 生成器自己去「确认一下」不算 ——
它与动作共享同一个上下文，共享同一组错误假设。

### 1.6.2 截图的位置

- 截图**只能作辅助**材料，用于「给读者看长什么样」。
- **不得**作为关键路径上的唯一证据（`screenshot` 在 `EVIDENCE_KINDS` 里 `strong: false`，
  所以 `weak_replaces_strong` 会自动拦下它）。
- 可接受的「读界面状态」的强证据是**由独立进程读出的结构化状态**，例如
  本仓 `scripts/uia-probe.ps1` 的 `read-prompt`：它把控件当前值读成文本并回读校验，
  退出码区分「读到了」与「验证不符」。那是可重放的观察器输出，不是一张图。

### 1.6.3 如何判定「这是 GUI 类交付」（可判定）

一条交付属于 GUI 类，当且仅当**至少一个关键路径**满足下列任一条：

1. `keyPaths[].path` 指向的产物是 `.ps1` / `.ahk` / `.xaml` / `.tsx` / `.vue` / `.html` 之类的
   界面或界面驱动文件；
2. 该关键路径的验收标准里出现「按钮 / 点击 / 输入框 / 窗口 / 控件 / 渲染 / 界面 / 开关」这类
   界面对象名词；
3. 该关键路径的 `requiredStrong` 里写入了 `artifact` 且产物是图片。

判据 1、3 可机械判定（路径后缀、产物后缀）。**判据 2 不可靠**（自然语言匹配），
它只作为提醒信号，不作为自动拦截的依据。这一条是本节的诚实边界。

判定为 GUI 类之后，`requiredStrong` **必须**至少含 `file_content` 或 `artifact`（结构化状态），
**不得**只有 `screenshot`。

## 1.7 验收与红队的上下文隔离（硬约束）

> 这是**规则**，不是建议。偏离必须在 `tasks/accepted-deviations.md` 登记。

### 1.7.1 实证依据

多 Agent 验证生效的机制是**多样性**，不是「更多次自我反思」。
同一个模型同时做生成器和评估器，会在多轮迭代里复现同样的推理结构 ——
它会稳定地漏掉同一类问题，且越是「再检查一遍」，越会把同一个盲点说得更自信。

因此：

| # | 约束 | 可判定形式 |
|---|---|---|
| 1 | 验收 Agent 与红队 Agent **不得看到**生成 Agent 的推理过程或自述 | `compose-agent-prompt.mjs` 的 `checkPromptSpec` 第 9 项（`independence`）：`FORBIDDEN_CONTEXT[role]` 里的键一旦出现在 `--context-from` 里，**拒绝派发**（exit 1，且不落文件） |
| 2 | 二者**不得共享同一个审查上下文** | 两者各自独立派发；`redteam` 的禁止项含 `self_assessment` / `weak_points`，`acceptor` 另加 `review_score` —— 即验收看不到红队分数，红队也看不到执行者自述 |
| 3 | 门禁的有效性**不靠「多设几个 Agent」** | 靠审查视角是否真的不同 —— 可判定的部分只有第 1、2 条；「视角是否真的不同」不可机械判定（见 §1.7.4） |

### 1.7.2 现在是否真的生效（实测，2026-11-22）

**生效。** 三条证据，都可复跑：

1. **`--context-from` 是唯一入口**，且它真的会把内容渲染进提示词（`compose-agent-prompt.mjs:1045` 附近）。
   `check-structure.mjs` 的 `checkPromptWiring()` 守两件事：SKILL.md 必须提到
   `compose-agent-prompt` 与 `--context-from`，且脚本必须真的实现了 `args['context-from']`。
2. **实测拒绝**：给 `acceptor` 注入 `{ "review_score": 8 }` →
   ```
   独立性检查不过 → exit 1，输出 `independence — 注入了不该给 acceptor 的内容：review_score`
   且不落文件（`existsSync(out) === false`）。
   ```
3. **独立性清单来自注册表**（`scripts/roles.mjs` 的 `discoverRoles()`）：
   `review: [self_assessment, execution_log, weak_points]`、
   `acceptor: [...] + review_score`、`redteam: [self_assessment, weak_points]`。
   **frontmatter 可以覆盖它**（`forbiddenContext: a, b`，覆盖而非合并）——
   覆盖会被 `checkPromptSpec` 第 9 项真的读到（见 §1.7.3）。

### 1.7.3 frontmatter 的 `forbiddenContext` 覆盖：已生效（原 DF-079，2026-11-23 修复）

修前这是一条**死的路径**：`scripts/roles.mjs` 写着「角色也可以在 frontmatter 写
`forbiddenContext: a, b` 覆盖它」，注册表**确实**读到了这个字段，但
`checkPromptSpec` 直接查冻结表 `FORBIDDEN_BY_ID[roleId]` —— 覆盖**没有任何调用方消费**。

实测症状（2026-11-22，临时项目 + 一份 `oversight-executor.md` 副本）：

```
注册表 executor.forbiddenContext = ["self_assessment"]
compose independence = true | 该角色无额外禁止项      ← 覆盖没生效
```

后果是**配置坏了但看起来一切正常**：项目以为自己加了一道闸，而那道闸没接线。

**现在的实现（两处，缺一不可）**：

1. `checkPromptSpec` 收 `roles` 参数，第 9 项**先查注册表记录**，
   冻结表只在记录不存在时作缺省。顺序不能反 —— 反了就等于「覆盖只在冻结表没有该角色时
   生效」，而那正好是 6 个角色之外的所有人，是一项不会被注意到的半修。
2. `compose` 的 CLI 把 `rolesFor(root)` 传进 spec。不传的话函数回落到 `defaultRoles()`
   （框架注册表），**项目的**覆盖在派发时会被静默忽略。

通过时的理由会写「（来源：注册表 / 冻结表）」—— 没有它，「覆盖生效」与
「恰好没有禁止项」在屏幕上同形。

**可复算的验证**（`scripts/forbidden-override.test.mjs`，6 条，全部 spawn 真 CLI）：

| 场景 | 期望 |
|---|---|
| executor 加 `forbiddenContext: self_assessment`，注入 `self_assessment` | exit 1，`independence` ✗ |
| 去掉覆盖，同样的注入 | exit 0，`independence` ✓ |
| acceptor 只写 `self_assessment`，注入 `review_score` | exit 0（覆盖是**替换**不是合并） |
| acceptor 不写覆盖，注入 `review_score` | exit 1（冻结表照旧生效） |
| 回退：CLI 不再传 `roles` | 前两条 + 回退断言，共 3 条红 |

### 1.7.4 这条规则不能机械判定的部分

「二者是否共享同一个审查上下文」在**派发侧**可判定（不提供路径即可），
在**执行侧**不可判定：一个 Agent 完全可以自己去读它没被给到的文件。
本仓的处置与 `dispatch-contract.md` §3 一致 —— **靠不提供，不靠 prompt 里写「请不要读」**，
并把这个残留风险如实写在这里，而不是假装它不存在。


## 2. 置信度分级

| 级别 | 含义 | 是否计入主清单 |
|---|---|---|
| `[确定]` | 已实际验证，可复现 | 是 |
| `[高]` | 静态证据充分，未运行验证 | 是 |
| `[中]` | 有证据但存在未排除的替代解释 | 是 |
| `[待验证]` | 假设，需运行期/实机验证 | **否**，必须单独成区 |

`[待验证]` 条目混入主清单视为**虚报**。

## 3. 立案前必须验证的三件事

写下一条 finding 之前，回来路验证：

1. **调用链真的通吗？** grep 所有调用点，别假设。
2. **有没有被别处拦截？** 查上游的判空、门禁、try-catch。
3. **在不在豁免清单里？** 若你认为豁免清单本身错了，写「豁免挑战」节单列，附证据。

## 4. 覆盖声明（强制）

每份 finding 报告末尾必须包含：

```markdown
## 覆盖声明
- 我实际读了哪些文件：<完整清单>
- 我做了哪些检查：<逐项>
- 我**没**做什么：<诚实申报>
- 我无法核实的部分：<原因>
```

**没有覆盖声明 = 报告不合格**。这条针对的是「看起来读了很多、实际只扫了目录名」的失效模式。

## 5. 两本台账（范围控制）

### 5.1 `tasks/dev-findings.md` —— 范围外发现

执行 Agent 在**任务范围外**发现的 bug，一律**不得自行修复**，登记到这里，由主线程统一排期。

为什么要这条：不设边界时，修一个 bug 会扫出三个存量问题，修完又扫出五个，任务永远不闭环。

状态枚举固定五值：`open` / `triaged` / `scheduled` / `fixed` / `wontfix`。

### 5.2 `tasks/accepted-deviations.md` —— 已知不修

记录**已知但本轮不修**的偏差。审查时，本文件列出的条目**不计入判定**。

新增条目必须由主线程确认后写入。每条必须含：偏差描述、为什么接受、复核日期。

两本台账配合形成债务生命周期：**发现 → 排期 → 修 / 正式豁免**。

## 6. 禁止的行为

| 禁止 | 为什么 |
|---|---|
| 用「可能」「大概」「建议进一步」代替证据 | 无法验证的猜测会污染清单 |
| 把别人的结论当自己的证据 | 你不知道对方的上下文 |
| 报告里写「已全面审查」但覆盖声明为空 | 谎报覆盖 |
| 为让报告好看而合并同类问题 | 数量失真，掩盖严重度 |
| 只报高严重度、隐藏低严重度 | 低严重度往往是高严重度的线索 |

## 7. 对锐评 Agent 的额外要求

锐评管「好不好」，输出：

```
## 锐评分：X/10
## 最致命的 3 个问题（每条：问题 / 证据 / 为什么致命）
## 各维度评分（表格）
## 如果只改一处，改哪里（一句话，必须具体到可执行动作）
```

**锐评可以主观，但必须可反驳**。「整体感觉不够好」不是锐评；「第 3 章的阈值与第 5 章的实测数据矛盾」是锐评。

## 8. 对验收 Agent 的额外要求

验收管「过不过」，输出：

```
## 验收结论：通过 / 不通过
## 逐项判定（表格：# / 判定 / 证据引用 / 说明 / 关键路径）
## 否决理由（逐条）
## 未覆盖项
## 覆盖声明

```evidence-json
[{"id":"E1","ac":"AC1","key_path":"K1","kind":"test","command":"...","producedBy":"acceptor"}]
```
```

**验收必须对照预先声明的标准**。事后新增标准视为无效判定。找不到证据即判不通过——**「没找到反例」不等于「通过」**。

### 8.1 判定表的三条机械要求（实现见 `parseAcceptorVerdict()`）

| 要求 | 判据 | 违反后果 |
|---|---|---|
| 结论必须能被读出 | `## 验收结论：通过` 或 `：不通过`，逐字 | 读不出 → `UNKNOWN`，裁决里判 `BLOCKED`，**不等于放行** |
| 结论「通过」必须有逐项判定 | 至少一行 `\| ACn \| 通过 \| 证据 \|` | 只有整体印象 → 报「整体看起来不错不是判定」 |
| 判通过的项，证据列不得为空 | 证据列非空且不是 `—` / `-` | 报「没找到反例不等于通过」 |

另外两条**自相矛盾**的检测：有 `ACn` 判不通过却写总论「通过」；以及
`evidence-json` 块解析失败（解析不了**不能**当成「没有结构化证据」）。

### 8.2 关键路径列

判定表的第五列（表头须含「关键路径」或 `key_path`）把这一步挂到 §1.5.5 声明的 `K` 上。
**按表头定位，不按固定列序猜** —— 固定列序会把「说明」列读成 `key_path`，
于是强证据挂在一条不存在的路径上，判据永远判不过而屏幕上看不出原因（实测踩过）。
没有这一列表头时，`key_path` 一律为 `null`，不猜。

## 9. 红队的三档权限与回流

> 实现：`scripts/delivery-verdict.mjs` 的 `redteamItemProblems()` / `deliverVerdict()`。
> 枚举：`RT_DISPATCH = ['block', 'accept', 'advisory']`。

### 9.1 现在的问题

红队的产出是一份报告，但**没有写明它的裁决效力**。一份「反例列表」读完，
读者无法判断：这条反例是「必须修」，还是「记一笔继续走」，还是「我知道、我接受」。

### 9.2 三档，各带一个可判定的必要条件

| `dispatch` | 含义 | 必要条件 | 能不能交付 | 回流 Phase |
|---|---|---|---|---|
| `block` | **阻断**：已核实、落在关键路径上 | `key_path` 必须在派发前的 `keyPaths` 里 | **否**，进 `BLOCKED` | Phase E：先修复，再**完整**重新验收 |
| `accept` | **风险接受**：我知道这个风险，接受 | `accepted_by` 必须非空（谁、何时） | 能，但留记录 | 无（记录进 `risky[]`） |
| `advisory` | **非阻断**：记录风险，交付可继续 | 无额外条件；但**不等式**：不许缺省成它 | 能 | 无；未登记偏差台账时打 `risk_unlogged` |

三条**都是可判定的**：`dispatch` 必须是枚举值、`block` 必须有 `key_path`、
`accept` 必须有 `accepted_by`、`evidence` 必须像可核查的锚点（`isAnchored()`）。

### 9.3 为什么缺省**不能**是 `advisory`

`advisory` 与 `accept` 都让交付继续。如果「没写 `dispatch`」静默落成 `advisory`，
那么**忘记写**与**明知故犯**在屏幕上同形 —— 而这正是本文件 §6 要禁的那种「污染」。
所以 `dispatch` 缺失时 `redteamItemProblems()` 直接报错，`deliverVerdict()` 判 `BLOCKED`
（码 `redteam_malformed`）：一份判不了的红队报告，**不能**被当成「没有阻断项」。

### 9.4 严重度不参与阻断判定

`severity`（`high` / `medium` / `low`）是红队自己的**主观量**，只用于排序提示。
阻断只看 `dispatch`。反过来的写法（「严重度高就自动阻断」）是把权限偷换成严重度，
而严重度恰恰是最容易被红队情绪影响的那个字段。两条测试钉住了这个方向：
`severity: high` + `dispatch: advisory` **不**阻断；`severity: low` + `dispatch: block` **照样**阻断。

### 9.5 「验收 PASS 但红队 BLOCK」是合法状态

今天实测过这个形态：验收判 PASS（14/14），红队判「不能交付」，**两者都成立** ——
验收判的是预声明标准，红队找的是标准之外的东西。

交付裁决必须有**显式函数**，不能靠人「感觉哪个对」。本仓的裁决函数是
`deliverVerdict({ acceptor, redteam, criteria, deviationRefs })`，纯函数，返回
`{ verdict, blocking, risky, reasons, phases }`。优先级**固定**，不是加权平均：

| 序 | 条件 | 裁决 |
|---|---|---|
| 1 | 红队有 `block`（`key_path` 已声明） | `BLOCKED` |
| 1b | 红队条目不可判定（缺 `dispatch` / `evidence` / `accept` 缺 `accepted_by`） | `BLOCKED` |
| 1c | 红队声称 `key_path` 但清单里没有 | `BLOCKED`（`key_path_undeclared`） |
| 2 | 验收结论不是 PASS | `FAILED`（`UNKNOWN` 则 `BLOCKED`） |
| 3 | 关键路径上无强证据 | `BLOCKED`（`weak_replaces_strong`） |
| 4 | 其余 | `PASS`（`advisory` 未登记台账时带 `riskUnlogged: true`） |

**红队阶段排在验收之前**，这是刻意的：验收 PASS 不能抵消红队阻断。
把它们加权求和，等于让「标准写得好不好」决定标准之外的风险能不能被看见。

`BLOCKED` 与 `FAILED` 分开返回，因为**处置不同**：前者要补采样 / 补强证据，
后者要修复后重验。混成一个「不通过」会让下一步动作无从确定。

### 9.6 回流规则的唯一形态

`deliverVerdict()` 返回的 `phases[]` 就是回流目标，**每个阻断码都自带一个 Phase**：

| 码 | 回流 |
|---|---|
| `redteam_block` | Phase E：先修复，再完整重新验收 |
| `redteam_malformed` | Phase B：红队重采样 |
| `redteam_no_coverage` / `redteam_coverage_incomplete` | Phase B：红队补覆盖声明（重采样） |
| `key_path_undeclared` | Phase A：下一轮派发前补声明关键路径（**本轮不可事后补**） |
| `strong_req_undeclared` / `strong_req_weak` | Phase A：修正强证据要求 |
| `weak_replaces_strong` | Phase E：补一次可重放的强证据，再验收 |
| `accept_not_pass` | Phase E：修复后完整重新验收 |
| `accept_unknown` | Phase E：补一次可读出结论的验收 |

**「本轮不可事后补」这一条要单独说清**：`key_path_undeclared` 的回流是 Phase A ——
也就是**下一轮**，不是这一轮的补救。事后往 `keyPaths` 里加一条就能让红队的阻断失效，
那等于给阻断开了一个后门，而这正是硬约束 4 存在的理由。

## 10. 交付裁决函数：调用位置与调用形态

| 调用点 | 时机 | 输入从哪来 | 形态 |
|---|---|---|---|
| 派发红队前 | Phase B | `criteria` 来自 `task-graph.json` 的子树（`keyPaths` / `requiredStrong`），写进红队提示词的**预先声明**段 | 函数调用（`deliverVerdict()`） |
| 收活时 | Phase E 第 0 步 | `--acceptor tasks/runs/<id>/acceptor.md`、`--redteam tasks/runs/<id>/redteam.md`、`--key-paths tasks/runs/<id>/keypaths.json`；`--deviation-refs tasks/accepted-deviations.md` | **CLI**：`node scripts/delivery-verdict.mjs` |

**收活那条已经接上了**（2026-11-23，DF-080 关闭）。`SKILL.md` 的 Phase E 第 0 条就是它，
退出码就是裁决：

| exit | 裁决 | 下一步 |
|---|---|---|
| 0 | `PASS` | 交付 / 进 Phase F |
| 1 | `FAILED` | 修复后**完整**重验（§8） |
| 2 | `BLOCKED` | 按输出的「回流」行处置（补采样 / 补强证据 / 补声明） |
| 3 | 用法错误 | 先补报告文件，**不许当成通过** |

三个设计点值得单独说，因为它们都是「读不到 ≠ 通过」的具体形态：

1. **`--acceptor` 文件不存在 → exit 3**，不回落成「空报告 → 没有阻断项」。
   「你说要给但文件不在」与「函数层的缺省」是两件事，后者只给**调用方已经决定不提供**
   的场景用。
2. **红队报告解析不出表 → 折成一条 `dispatch=block` 的 malformed 条目**。
   一份判不了的红队报告不能当成「没有阻断项」，那正是 §2 说的静默共识。
3. **报告的解析是表头驱动的**：列名换了措辞读对，列序换了也读对。按固定列号读会把
   「说明」读成 `key_path`，于是强证据挂在一条不存在的路径上，判据永远判不过，
   而屏幕上只看得出「红队判了阻断」——`parseAcceptorVerdict()` 的 `key_path` 一段
   记着同一件事。

**还没做的（如实列出）**：`validate-run.mjs` 的派发前校验**没有**接过 `keyPaths` 的
合法性校验。也就是说，`keypaths.json` 现在由主线程手写，写成什么形状都不会在派发前被拒；
它只会在收活时表现为「所有 block 条目都是 `key_path_undeclared`」。
这条缺口的方向是对的（判据在收活侧仍然生效），但**派发前就拦住**比收活时才发现好 ——
登记为后续任务，不假装已做。

