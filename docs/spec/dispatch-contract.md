# 派发契约

> 每个子 Agent 的 prompt = **本文件的公共段** + **Planning 现写的域专属段** + **baseline 事实快照**。
> 三段缺一视为规划缺陷，退回 Planning Agent（规格 §2.8）。

## 1. 拼装规则

```
prompt = templates/dispatch.md（公共段，长期稳定）
       + planning 现写（域专属：目标 / 文件清单 / 风险假设 / 定制检查项）
       + templates/baseline.md（当轮事实快照：commit、规模、已知问题数）
```

**为什么域专属段不预置**：参考项目预置了 30+ 份 `review-plan.md`，结果全部腐烂——没人知道哪份是当前真相。域段必须每次现写，写完即用完。

**为什么 baseline 必须共享**：所有 Agent 对同一组数字发言，才能发现「A 说 87 个文件、B 说 92 个」这类矛盾。baseline 由主线程派发前生成，不读其他 Agent 的输出。

## 2. 每个 Agent 必须收到的四样东西

| # | 内容 | 缺失后果 |
|---|---|---|
| 1 | 原始任务描述（不是别人的转述） | Agent 会优化一个错误的目标 |
| 2 | **预先声明的验收标准** | 事后编造标准，验收失去意义 |
| 3 | 产出形态声明（`artifact` / `exploration` / `hybrid`） | 无法判定「8 分钟无 Write 是否异常」 |
| 4 | token 预算与容忍窗口 | 无法做预算管理，只能事后惊讶 |

## 3. 独立性约束（防锚定）

| 角色 | 不得读取 | 原因 |
|---|---|---|
| 锐评 Agent | 执行 Agent 的自我评价、执行日志 | 会在别人的框架里打分 |
| 验收 Agent | 锐评 Agent 的分数 | 锐评管「好不好」，验收管「过不过」，混了就变成一个人 |
| 批判 Agent | 其他批判 Agent 的结论 | 防止第一个发言者定义议题 |
| 红队 Agent | 执行 Agent 的薄弱点自述 | 会直接照着打，失去独立构造反例的意义 |
| 探针 Agent | 目标 Agent 的推理文本，**只读工具调用日志** | 推理文本会诱导探针认同目标 |

**实现方式**：不靠 prompt 里写「请不要读」，靠**不提供路径**。主线程派发时只给必要的输入文件路径。

## 4. 角色清册

| 角色 | 工具白名单 | model | 职责 | 不可合并的理由 |
|---|---|---|---|---|
| `planner` | Read, Write, Glob, Grep | inherit | 拆解任务，声明验收标准与产出形态 | — |
| `executor` | Read, Write, Edit, Bash, Glob, Grep | inherit | 实质执行 | — |
| `research` | Read, Grep, Glob, WebSearch, WebFetch | inherit | 搜集外部事实 | 需要网络，executor 不该默认有 |
| `critic` | Read, Grep, Glob | inherit | 质疑**拆解与前提** | 输入是拆解图，不是交付物 |
| `redteam` | Read, Grep, Glob, Write | inherit | 攻击**交付物与结论** | 输入是交付物，不是拆解图 |
| `review` | Read, Grep, Glob, Write | inherit | 质量评分（1–10） | 主观评分，与客观判定分离 |
| `acceptor` | Read, Grep, Glob, Write | inherit | 对照预声明标准判定，一票否决 | 客观判定，不写分数 |
| `repair` | Read, Write, Edit, Bash, Glob, Grep | inherit | 仅在失败时触发 | 需要写权限，但不得改验收标准 |
| `probe` | Read, Grep, Glob | haiku | 只读日志判 `HEALTHY/UNFOCUSED/LOOPING` | 纯判定，允许短生命周期 |
| `relay` | Read, Grep, Glob, Write | inherit | 产出接力草稿 | — |
| `safety` | Read, Grep, Glob | haiku | 检查草稿是否触碰红线 | 输入是草稿，与 relay 的输入不同 |
| `resolution` | Read, Grep, Glob, Write | inherit | 裁决分歧 | 输入是双方原话，与 safety 不同 |

**`critic` / `redteam` / `review` / `acceptor` / `safety` / `probe` 全部没有 `Edit`**。这不是 prompt 里的「请勿修改」，是工具集物理限制。`scripts/check-structure.mjs` 会验证这一点。

**为什么 `relay` 和 `safety` 不合并**：合并后就是「自己写草稿、自己审红线」，重演参考项目「锐评自己写自己」的失效模式。

## 5. 产出形态声明格式

Planning 派发每个 Agent 时必须写明：

```yaml
shape: artifact | exploration | hybrid
acceptance:                      # 预声明，事后不得增补
  - id: AC1
    criterion: <可观测事实>
    evidence: <引用形式，如 file:line>
    fail_if: <什么情况直接否决>
token_budget_pct: 40
timeout_min: 8
```

## 6. 返回值格式

子 Agent 的最终返回**不是散文**，是结构化三元组：

```
## 交付物
<路径 或 内联结论>

## 执行日志
<关键决策点，每条一行，不写过程叙事>

## 我认为的薄弱点
<1–3 条，主动暴露>
```

返回超过 15 行视为格式不可解析，按 `docs/spec/state-model.md` §2 判定。**注意：不得因「没有交付物」直接判失败**——必须先过状态判定，`EXPLORING` 态的空返回是正常的。也**不得**因「停了很久」判 `FAILED`：那个推断已删除（`state-model.md` §2.0.1），`FAILED` 只认宿主上报。

## 7. 递归派生

**v0 的实际深度是 1 层**（主线程 + 一层执行者）。这是**设计选择**，也是**当前配置的事实**。

### 为什么是 1 层：三条实测证据

1. **12 份角色定义的 `tools:` 白名单里，没有一个含派生子 Agent 的工具。**
   实测全集只有 8 种：`Bash / Edit / Glob / Grep / Read / WebFetch / WebSearch / Write`。
   Claude Code 的 `tools` 语义是**精确白名单**（列出即只给这些），所以这 12 个角色
   **物理上派生不出下一层**。
2. **宿主对 subagent 本来就不开放这条能力**（只对 fork 形态例外）。
   即便给某个角色加上工具名，深度 2 的下一层仍然拿不到派生能力。
3. **结构硬门对它无感。** `checkAgents()` 只校验「只读角色不得含 `Edit`/`Bash`」，
   不校验派生工具的有无 —— 也就是说「我们以为自己有几层」这件事**没有任何检查守着**，
   只能靠人读角色定义。

### 平台能力 ≠ 本仓架构（这条要单独说清）

宿主**支持**更深的派生（默认上限 3 层，见 `docs/adr/0001-config-only.md`）——
那是**平台能力**，不是本仓的架构承诺。榜样的区别：

| | 含义 | 本仓现状 |
|---|---|---|
| 平台能力 | 宿主允许做到几层 | 3 层 |
| 本仓架构 | 这一版**实际采用**几层，以及为什么 | **1 层** |

**把平台能力写成架构承诺，是本仓已经犯过一次的错**（`docs/design/2026-11-10-agent-framework-skeleton.md:159`
当时就判定「规范声称的能力在实际配置里不存在，这比没有规范更坏 —— 一个读者会据此设计三层方案」）。
本节的修改就是那次判定的执行。

### 递归不在 v0 范围内

若将来要做，前提是三条**同时**满足，缺一不可：

1. 给需要递归的角色**显式加**派生工具，并接受随之而来的 token 代价（约 15×）；
2. 每一层派发必须写明「**为什么需要这一层，而不是由父级自己完成**」——
   写不出理由就不许派生；
3. 它需要**独立裁决**，不随 v0 顺延（即：不能因为「v0 没做完」就默认下一版要做）。

**深度 ≥2 时**，报告中必须标注「此结论在深度 N 仍未收敛」。
