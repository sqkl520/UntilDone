#!/usr/bin/env node
/**
 * roles.mjs — 「有哪些角色」的唯一实现。
 *
 * 为什么需要它：同一个角色在本仓库曾经有三个名字空间 —— 目录里的 `oversight-acceptor.md`、
 * 配置 roster 里的 `oversight-acceptor`、任务图里的 `capability: "acceptor"`。
 * 于是 `compose --role oversight-acceptor` 拼出了 `oversight-oversight-acceptor.md` 并报
 * 「没有这个角色的定义」（实测，见 `tasks/dev-findings.md` DF-044）。
 *
 * 在这之前，加一个角色要改 9 个地方（目录 + 6 份脚本里的字面量清单 + 配置 + SKILL.md +
 * planner 的角色表）。九份清单必然漂：它们没有一份是「从别的来源派生」的，
 * 改八份漏一份，屏幕上和八份对过的那份一模一样，而漏掉的那处只在某个分支上才响。
 *
 * 现在只有两个落点：
 *   1. `.claude/agents/<角色>.md` 的 frontmatter（身份、工具、只读、显示名、禁止上下文）
 *   2. 本文件的读取规则
 *
 * ── id 怎么来 ────────────────────────────────────────────────────────
 *
 *   frontmatter 写 `id:` 就用它；否则**去掉前缀**（默认 `oversight-`）。
 *   现有 12 份 `.md` 有 `name: oversight-acceptor` 无 `id:`，去前缀正好得到 `acceptor`，
 *   与任务图里的 `capability` 逐字相同 —— 那是「三个名字空间」收敛成一个键的支点。
 *
 *   为什么要前缀而不是写死 `name.slice(9)`：本库会被别处当模板用，那边的角色可能叫
 *   `my-review-helper`。前缀是**参数**（`agentPrefix`），不是常量假设；
 *   而 `my-review-helper` 前缀不匹配时，id 就是它自己 —— 不会因为名字里含 `review`
 *   就被当成某个已知角色的别名。
 *
 * ── 只读为什么读 frontmatter 而不是按名字子串匹配 ─────────────────────
 *
 *   原实现（`check-structure.mjs:285`）是
 *   `READONLY_ROLES.some((r) => name.toLowerCase().includes(r))`。
 *   子串匹配的失效方式不是「漏检」，是**误检且说不清**：用户建一个
 *   `my-review-helper`，因为名字含 `review` 被强制只读，报错只说「只读角色 X 拥有写工具」，
 *   而 X 的正文里从没写过它是只读角色。申明改成数据：`readonly: true`。
 *
 * 零依赖，只读盘。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, basename, sep, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 包根：脚本目录的上一级。**它有两种合法形态**（见下面 `agentsDirCandidates`）。
 *
 *  声明在文件头（而不是像以前那样放在末尾）是因为 `agentsDirCandidates` 的默认参数
 *  要用它 —— 函数声明会被提升，`const` 不会，写到末尾会让「零参数调用」在模块求值
 *  期拿到 TDZ 里的 `REPO_ROOT`。它同时是「算相对仓库根的路径」时唯一的基准。 */
export const REPO_ROOT = resolve(HERE, '..');

/** 框架角色目录的**候选**，按优先级排列。**不判断存在性**，由 `agentsDir()` 挑。
 *
 * ## 为什么是两个候选，而不是一个写死的常量（DF-062）
 *
 * 本框架以两种布局存在，两者的「包根」都是「scripts 目录的上一级」，但角色目录不同：
 *
 * | 形态 | 包根 | 角色目录 | 谁认它 |
 * |---|---|---|---|
 * | 本仓自用 / 用户项目 | `<repo>` | `<repo>/.claude/agents` | Claude Code 的**项目布局**自动加载 |
 * | plugin 载荷（`dist/payload`、`dist/roster`） | `<payload>` | `<payload>/agents` | 宿主的 **plugin 布局**（`--plugin-dir`），实测只认根下一层 |
 *
 * 修前这里是一个模块常量 `resolve(HERE,'..','.claude','agents')`：在载荷形态下它指向
 * `<payload>/.claude/agents`，**那个目录不存在**，于是 `validate-run` / `compose` /
 * `render-plan` 在载荷里拿到的角色表是空的（实测 12 个角色、认到 0 个）。
 * 「0 个角色」与「找错了地方」在屏幕上同形 —— 正是本仓反复出的那种静默失效。
 *
 * 顺序**先 `.claude/agents`**：它是本仓的现行布局，也是用户项目里的约定。
 * 两个目录同时有角色时取前者，行为与本仓历史一致；载荷里只有后者存在。
 *
 * 为什么不按 `UNTILDONE_PAYLOAD` 环境变量探测：那个变量只在**宿主会话**里由
 * `launch.mjs` 注入，而这三个消费者会在任意终端里被跑（`--check`、CI、测试）。
 * 拿环境变量当判据会让「同一个脚本在会话里和在终端里结论不同」，比目录探测更难解释。
 * 布局是**盘上的事实**，就从盘上读。 */
export function agentsDirCandidates(pkgRoot = REPO_ROOT) {
  const r = String(pkgRoot || '').trim();
  if (!r) return [];
  return [join(r, '.claude', 'agents'), join(r, 'agents')];
}

/** 一个候选目录的**盘上状态**。三档，`probeAgentsDir` 与 `scanRolesDir` 共用这一份判据。
 *
 *  - `dir`     是目录
 *  - `notdir`  存在但**不是目录**（实测：`<payload>/.claude/agents` 被建成普通文件时，
 *              修前的 `readdirSync` 抛 `ENOTDIR` 未捕获栈；而 `existsSync` 为真，
 *              所以修前那道 `existsSync` 守卫根本挡不住）
 *  - `missing` 不存在 / 读不了（`ENOENT`、`EACCES` 一律归此档：对调用方同一件事）
 *
 *  为什么要分档而不是布尔：`sourceText()` 要**按实际发生的事说**。把「存在但是个文件」
 *  说成「不存在或为空」正是 DF-062 的第一条整改意见 —— 一句错话会让读者去错的地方找。 */
function dirStateOf(dir) {
  const d = String(dir || '');
  if (!d) return 'missing';
  try { return statSync(d).isDirectory() ? 'dir' : 'notdir'; } catch { return 'missing'; }
}

/** 框架角色目录：候选里**第一个「有角色」的**。
 *
 *  ## 为什么判据是「有角色」而不是「存在」（DF-062 整改第 2 条）
 *
 *  修前这里是 `candidates.find((d) => existsSync(d)) || candidates[0]`，而同一个模块里
 *  `rolesFor()` 的项目分支用的是「存在**且至少有一个可解析的 `.md`**」（`if (list.length)`）。
 *  两套判据的差别有实测后果：在一个只多建了空 `.claude/agents/` 的载荷上，
 *  `existsSync` 认它、`readdirSync` 得到 0 个角色 → **12 个变 0 个**，而另一个候选里
 *  12 个角色好好的。也就是说「存在」这个判据会把一次成功的探测变成静默失效。
 *
 *  现在两个分支同构：候选按序扫，**取第一个扫得出角色的**。都扫不出角色时依次退到
 *  「第一个是目录的」→「第一个候选」，让调用方仍然拿到一个能打印、能去建的位置。
 *
 *  @returns {string|null} `pkgRoot` 为空时返回 null（不拼相对路径） */
export function agentsDir(pkgRoot = REPO_ROOT) {
  return probeAgentsDir(pkgRoot).dir;
}

/** 一次探测的**完整结果**：选了哪个 + 每个候选的盘上状态与角色数。
 *
 *  返回逐候选明细而不是只返回选中的那个，是因为 DF-062 的表现形式是
 *  「12 个角色、认到 0 个」，而屏幕上只有一个不存在的路径。**一个 0 的结果必须自带
 *  『我找过哪儿、每个地方看到了什么』** —— 只说「都不存在或为空」会把
 *  「有 12 个角色但排在后面」说成「没有」，那是假话。
 *
 *  `count` 用 `scanRolesDir` 真扫（与 `rolesFor` 的项目分支同一判据）。
 *  条数与 `agentPrefix` 无关（只有「name 与 id 都为空」的条目才会被跳过，而
 *  `idFromName` 在前缀不匹配时原样返回 name），但 **`roles` 里的 id 与它有关** ——
 *  见下面 `opts.agentPrefix` 那一段。
 *
 *  **扫出来的注册表本身也带回去**（`roles`，只有被选中的那个候选有）：
 *  `rolesFor()` 要同时要「选了哪个」和「那个目录里有什么」，让它自己再扫一遍就是
 *  一个请求两次读盘。实测同一份 12 个角色：分开扫 20.9ms，合并后 11.9ms。
 *  `agentsDir()` 只取 `dir`，所以对它的调用方（结构门探针）零变化。
 *
 *  `opts.agentPrefix` 必须**从这里传下去**，不能先用默认前缀扫、再指望调用方改：
 *  id 是「name 去前缀」的结果，前缀不同 → **id 不同**（只是条数相同）。
 *  `rolesFor()` 的框架前缀可能来自 `overwatch.config.json`（别人的项目是 `ow-`），
 *  拿 `oversight-` 扫出来的 id 会给出一份**看起来正常但全错**的注册表。
 *
 *  ## `warnings`：配置坏了就必须说出来，**哪怕最终成功了**
 *
 *  这条是被评审打回后加的，理由是一个具体的错：
 *
 *      <pkg>/.claude/agents 是普通文件，<pkg>/agents 有 12 个角色
 *      → 修前输出「框架角色目录 <pkg>/agents（12 个）」、一个字都不提那个坏掉的目录
 *
 *  用户去建 `.claude/agents` 说明他**想用那个位置**；他往那里加角色，会发现「加了没反应」——
 *  因为根本没读那里。这正是本仓台账里出现频率最高的缺陷形态：**配置坏了但看起来一切正常**
 *  （DF-031/033/039/040/041/047 都是「门报绿但检查没跑」）。所以「12 个角色」不能是
 *  闭眼的成功：只要某个候选处于 `notdir`，把它带出去让 `sourceText()` 打印。
 *
 *  噪音边界：正常形态（候选是目录、或根本不存在）**不产生任何 warning** ——
 *  这条在「一切正常」时一个字都不打印。
 *
 *  @param {string} [pkgRoot]
 *  @param {{agentPrefix?:string}} [opts]
 *  @returns {{dir: string|null, roles: Array<object>,
 *             tried: Array<{dir:string, state:'dir'|'notdir'|'missing', count:number}>,
 *             warnings: Array<{code:'notdir', scope:'framework', dir:string, chosen:string|null}>}} */
export function probeAgentsDir(pkgRoot = REPO_ROOT, { agentPrefix = DEFAULT_AGENT_PREFIX } = {}) {
  const candidates = agentsDirCandidates(pkgRoot);
  if (!candidates.length) return { dir: null, roles: [], tried: [], warnings: [] };
  // 每个候选只扫一次，扫出来的结果留着给被选中的那个用 —— 不用扫两遍。
  const scanned = candidates.map((dir) => {
    const state = dirStateOf(dir);
    const roles = state === 'dir' ? scanRolesDir(dir, { agentPrefix }) : [];
    return { dir, state, roles };
  });
  const withRoles = scanned.find((t) => t.roles.length > 0);
  const anyDir = scanned.find((t) => t.state === 'dir');
  const chosen = withRoles || anyDir || scanned[0];
  return {
    dir: chosen.dir,
    roles: chosen.roles,
    tried: scanned.map((t) => ({ dir: t.dir, state: t.state, count: t.roles.length })),
    // 「存在但不是目录」是**盘上坏了的配置**，与「没建」不是一回事。后者是正常的
    // （用户项目里没有就是没有），前者是用户建了、想让脚本读那里，却读不了。
    warnings: scanned
      .filter((t) => t.state === 'notdir')
      .map((t) => ({ code: 'notdir', scope: 'framework', dir: t.dir, chosen: chosen.dir })),
  };
}

/** 把绝对路径变成**可以打印进日志 / 提示词**的形态。
 *
 *  > 与 `render-plan.mjs` 的同名导出**不是同一个函数，也别合并**：那个是给「照着敲」
 *  > 用的（相对仓库根、回落只留最后两段），这里要的是**诊断**（两个候选必须能互相
 *  > 区分，且要说得出「在项目里 / 在载荷里 / 都不在」）。两者的回落形态不同是刻意的，
 *  > 合并任何一个都会让另一处的输出变得不可执行。
 *
 *  三级回落，判据都是「相对哪个根」：
 *    1. 在 `root`（用户项目）下 → `./agents`（相对 root，最可执行）；
 *    2. 在框架包根下 → `<pkg>/agents`（载荷形态：root 是用户项目，角色在载荷里，
 *       相对 root 是 `../../…` 那种既看不懂又泄漏的字符串）；
 *    3. 都不在 → `<abs>/.claude/agents`（保留最后两段，让两个候选还能区分开）。
 *
 *  为什么一定要有第 2、3 级：`sourceText()` 的注释写着「路径相对 `root` 打印」，
 *  而载荷形态下 `dir` **不在** `root` 底下 —— 相对化失效就等于把本机绝对路径打进
 *  transcript。DF-062 的实测输出里那条 `C:\Users\…\pkg\.claude\agents` 就是这么来的。
 *  同理 `root == null`（`rolesFor(null)`，只认框架）时第 1 级根本不成立，走的也是第 2 级。
 *
 *  占位符沿用仓库既有约定（`check-structure.mjs` / `launch.mjs` 的 `<repo>` / `<abs>`）。 */
export function displayPath(p, root = null) {
  const s = String(p == null ? '' : p);
  if (!s) return '(无)';
  // 相对路径没有「本机前缀」可遮，原样打印（生产里的候选都是绝对路径，这一支是给
  // 调用方手写的相对候选 / 测试夹具用的 —— 别为它编一个 `<abs>` 前缀出来）。
  if (!isAbsolute(s)) return s.split(sep).join('/');
  const fromRoot = root ? relUnder(root, s) : null;
  if (fromRoot != null) return fromRoot ? `./${fromRoot}` : '.';
  const fromPkg = relUnder(REPO_ROOT, s);
  if (fromPkg != null) return fromPkg ? `<pkg>/${fromPkg}` : '<pkg>';
  // 既不在项目下也不在包根下：留最后两段就够区分候选（`.claude/agents` vs `agents`），
  // 绝对前缀一律不出现。
  const tail = [basename(dirname(s)), basename(s)].filter(Boolean).join('/');
  return `<abs>/${tail}`;
}

/** `p` 相对 `base` 的路径（posix 分隔符）；不在 `base` 底下时返回 null。
 *  用 `relative()` 而不是字符串前缀比较：Windows 的盘符与目录名**大小写不敏感**，
 *  而 `startsWith` 会说两个写法不同的同一个目录无关 —— 那样只有大小写恰好一致的
 *  机器才会走相对化，另一些机器就把绝对路径打进日志。`path.relative()` 在 win32 上
 *  正是按不敏感比较的。 */
function relUnder(base, p) {
  const b = String(base || '');
  const q = String(p || '');
  if (!b || !q || !isAbsolute(q)) return null;
  const r = relative(resolve(b), resolve(q));
  if (isAbsolute(r)) return null;            // 不同盘符：`relative` 原样返回绝对路径
  if (r === '') return '';                   // 同一个目录
  if (r === '..' || r.startsWith('..' + sep)) return null;  // 在上层，不是「在下面」
  return r.split(sep).join('/');
}

/** 目录名 → id 的默认前缀。改它只影响「没写 `id:` 的那些 .md 怎么取名」。 */
export const DEFAULT_AGENT_PREFIX = 'oversight-';

/** 每个角色**不该拿到**的上下文。键是 id（`acceptor`，不是 `oversight-acceptor`）。
 *
 *  为什么这张表在注册表里而不是 compose 里：它是角色的属性（「验收看不得分数」是
 *  acceptor 这个岗位的定义），不是拼装器的属性。留在 compose，下一个消费角色的脚本
 *  就得再抄一份，而两份必然漂 —— 与整张清单被抄成九份是同一个病。
 *
 *  角色也可以在 frontmatter 写 `forbiddenContext: a, b` 覆盖它。
 *  覆盖而非合并：合并会让「删掉一项」变得不可表达。 */
export const FORBIDDEN_CONTEXT = Object.freeze({
  review: ['self_assessment', 'execution_log', 'weak_points'],
  acceptor: ['self_assessment', 'execution_log', 'weak_points', 'review_score'],
  redteam: ['self_assessment', 'weak_points'],
  critic: ['executor_output', 'review_score'],
  probe: ['reasoning_text'],
  safety: ['relay_rationale'],
});

/** 解析 frontmatter：支持 YAML 多行块（`|` / `>` / `|-`），否则多行 description 会被误判为空。
 *
 *  这是本仓库**唯一**一份 frontmatter 解析实现。原先 `compose-agent-prompt.mjs` 与
 *  `check-structure.mjs` 各有一份拷贝，两份对多行块的处理一致只是碰巧；
 *  而「角色有没有声明只读」现在两边都要读，一个解析差异就会让硬门放行、compose 拦下。
 *
 *  两种入参都收：**整份文件**（含 `---` 围栏）或**围栏内的正文**。
 *  这不是宽容，是让调用方不必知道「上一版是谁实现的」—— 硬门历来传的是正文，
 *  compose 历来传的是整份，任何一边改传法都不该让解析静默返回空对象。
 *
 *  @returns {Record<string,string>|null} 没有 frontmatter 时返回 null（不是空对象：
 *   空对象会让调用方误以为「解析成功、字段恰好都没写」）
 */
export function parseFrontmatter(text) {
  const src = String(text || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  // 传给我们的就是围栏内的正文（硬门的历史调用方式）：没有围栏时按整段当正文。
  const body = m ? m[1] : (/^[A-Za-z_][\w-]*\s*:/.test(src) ? src : null);
  if (body == null) return null;
  const out = {};
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, inline] = kv;
    if (inline === '|' || inline === '>' || inline === '|-') {
      const block = [];
      let j = i + 1;
      while (j < lines.length && (/^\s+\S/.test(lines[j]) || lines[j].trim() === '')) { block.push(lines[j].trim()); j++; }
      out[key] = block.join(' ').trim();
      i = j - 1;
    } else {
      out[key] = inline.trim();
    }
  }
  return out;
}

/** YAML 里的真值。**只认明确的几种写法**：`readonly: no` 不能被当成 true，
 *  而拼错的 `readonly: ture` 也不能静默变成「是」—— 那会让角色意外获得写权限或
 *  意外被禁，两种都说不清。认不出时按 false 处理，并由 `check-structure.mjs` 报警。 */
export function truthyFlag(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'on' || s === '1';
}

/** 一条角色定义 → 「它是只读的吗」。
 *
 *  判据只有 frontmatter 里的 `readonly`。**没有**名字猜测、没有子串匹配、
 *  没有内置白名单 —— 这三样都会让「为什么它被当成只读」不可回答。 */
export function readonlyOf(frontmatter) {
  return truthyFlag(frontmatter && frontmatter.readonly);
}

/** 只读角色的 `Bash` 声明。**合法取值只有一个**：`read-only`。
 *
 *  ## 为什么需要这个字段（2026-11-23，`oversight-verifier`）
 *
 *  `checkAgents()` 的规则是「`readonly: true` 的角色不得拥有 `Bash`」，理由是
 *  「`Bash` 能写盘，而 `Write` 至少可以从路径上限制」。这条规则在一个场景下是错的：
 *  **核验类角色**的职责就是跑只读命令去核事实（`grep` / `wc` / `node --test`），
 *  没有 `Bash` 它物理上做不了这件事，只能退化成「读一遍源码觉得它对」—— 那是判断，
 *  不是核验。
 *
 *  ## 为什么不是「放开 Bash」
 *
 *  放开 `Bash` 会让六个只读角色全部获得写盘能力，而它们的职责里没有一条需要跑命令。
 *  所以这里**不放开工具**，而是要求角色额外声明 `bashScope: read-only`：
 *    · 写了 → `Bash` 合法，但正文必须同时给出「允许的命令」清单（`checkAgents()` 核这一条）；
 *    · 没写 → 与修前逐字相同，`Bash` 仍然是违规。
 *
 *  这是**收紧**不是放松：修前「只读 + Bash」一律违规；修后要求多一个字段 + 一段清单。
 *  一个漏写清单的角色照样红。
 *
 *  ## 认不出的值一律当「没写」
 *
 *  `bashScope: readonly` / `read-only-bash` / `r` 都不认 —— 与 `truthyFlag` 同一条理由：
 *  拼错的值如果被当成「是」，一个本来该红的角色会静默变绿。 */
export const BASH_SCOPES = Object.freeze(['read-only']);

export function bashScopeOf(frontmatter) {
  const v = String((frontmatter && frontmatter.bashScope) || '').trim().toLowerCase();
  return BASH_SCOPES.includes(v) ? v : null;
}

/** 从 `name` 去前缀得 id。前缀不匹配时原样返回（别人的角色不必叫 oversight-*）。 */
export function idFromName(name, agentPrefix = DEFAULT_AGENT_PREFIX) {
  const n = String(name || '').trim();
  const p = String(agentPrefix || '');
  if (p && n.toLowerCase().startsWith(p.toLowerCase()) && n.length > p.length) return n.slice(p.length);
  return n;
}

/**
 * 扫一个角色目录，产出注册表。
 *
 * @param {string} [dir] 默认 `agentsDir()`（按包根探测两种布局；见该函数）
 * @param {{agentPrefix?: string}} [opts]
 * @returns {Array<{id:string, file:string, tools:string[], readonly:boolean,
 *                  bashScope:string|null, forbiddenContext:string[], display:string, name:string}>}
 *   `file` 是绝对路径（读它用）；提示词里要打印**相对路径**，由调用方用 `displayPath()`
 *   算，绝不把本机路径写进任何会被发出去的东西。
 *   目录不存在时返回 `[]` —— 空注册表让下游「一个角色都不合法」，
 *   比静默给一份内置清单安全（后者会让「目录丢了」看起来一切正常）。
 *
 *   默认值**每次调用时求值**（`agentsDir()` 探测两种布局），不是模块加载时的常量。
 *   这是 DF-062 的一半修法：常量在载荷形态下会指向一个不存在的目录。
 */
export function discoverRoles(dir = agentsDir(), { agentPrefix = DEFAULT_AGENT_PREFIX } = {}) {
  return scanRolesDir(String(dir || ''), { agentPrefix });
}

/** `discoverRoles` 的本体，只是**不**给 `dir` 默认值。
 *
 *  拆出来是因为 `probeAgentsDir()` 要按候选逐个扫，而它自己就在推断「默认目录是哪个」——
 *  让它去调带默认值的 `discoverRoles()` 就成了自指（探测的候选项来自探测结果）。
 *  显式传目录的小函数，两个调用方各拿到自己要的语义。
 *
 *  **契约：任何「扫不出来」都返回 `[]`，不抛。** 修前这里是
 *  `if (!existsSync(d)) return [];` —— 而 `existsSync` 对一个**普通文件**返回 true，
 *  于是下一条 `readdirSync` 直接抛 `ENOTDIR`。实测形态：
 *
 *      $ mkdir -p <pkg>/.claude && touch <pkg>/.claude/agents
 *      $ node -e "import('.../roles.mjs').then(m => m.discoverRoles())"
 *      Error: ENOTDIR: not a directory, scandir '…\pkg\.claude\agents'
 *
 *  那个栈会从 `question-audit.mjs:125`（模块顶层 `discoverRoles()`）一路顶到宿主
 *  import 这个模块的地方 —— 一个「目录不存在时返回 `[]`」的函数，在目录类型不对时崩了。 */
function scanRolesDir(d, { agentPrefix = DEFAULT_AGENT_PREFIX } = {}) {
  if (!d) return [];
  let entries;
  // **这一条 try 就是 DF-062 整改第 4 条的全部修法**，故意只写在一处：
  // 修前是 `if (!existsSync(d)) return [];` 紧跟一句裸 `readdirSync(d)`。`existsSync`
  // 对一个**普通文件**返回 true，于是 `readdirSync` 抛 `ENOTDIR` 一路顶出模块 ——
  // 在 `question-audit.mjs` 这种模块顶层调用 `discoverRoles()` 的地方，它崩的是
  // **宿主 import 这个模块**的那一步。契约写的是「扫不出来返回 `[]`」，那就不许抛。
  //
  // 为什么不再加一层 `statSync().isDirectory()` 守卫：那会变成两处判据，只回退其中
  // 一处仍然不抛 —— 负向验证于是假绿。一个修复点，一次回退，必须红。
  try {
    entries = readdirSync(d).filter((x) => x.endsWith('.md')).sort();
  } catch { return []; }
  const out = [];
  for (const f of entries) {
    const file = join(d, f);
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const fm = parseFrontmatter(text) || {};
    const name = String(fm.name || basename(f, '.md')).trim();
    const id = String(fm.id || idFromName(name, agentPrefix)).trim();
    if (!id) continue;
    const tools = String(fm.tools || '').split(',').map((s) => s.trim()).filter(Boolean);
    const forbiddenContext = fm.forbiddenContext !== undefined
      ? String(fm.forbiddenContext).split(',').map((s) => s.trim()).filter(Boolean)
      : [...(FORBIDDEN_CONTEXT[id] || [])];
    out.push({
      id,
      file,
      tools,
      readonly: readonlyOf(fm),
      // `bashScope`（2026-11-23）：只读角色要跑只读命令时的显式声明。
      // 注册表把它带出来，是为了让「为什么这个只读角色能有 Bash」只有一个答案 ——
      // 一份 .md 的 frontmatter 里写了 `bashScope: read-only`，且正文给了命令清单。
      bashScope: bashScopeOf(fm),
      forbiddenContext,
      display: String(fm.display || '').trim() || id,
      name,
    });
  }
  // 同 id 两份文件不是「后一份覆盖前一份」，是仓库本身坏了：下游按 id 查表会静默取其一。
  // 报在结构门（check-structure.mjs 用 discoverRoles），这里只保证顺序稳定。
  return out;
}

/**
 * 把一个用户写的名字解析成一条角色定义。**先全名，后加前缀。**
 *
 * 于是 `--role acceptor` 与 `--role oversight-acceptor` 都可用 —— 三个名字空间
 * （文件名 / 配置 / 任务图）里的任何一种写法都不必再被记住。
 *
 * @returns {object|null} 找不到返回 null（调用方必须报错，不能回落成「随便挑一个」）
 */
export function resolveRole(roles, name, { agentPrefix = DEFAULT_AGENT_PREFIX } = {}) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return null;
  const list = Array.isArray(roles) ? roles : [];
  // 1) 全名（frontmatter 的 name）
  const byName = list.find((r) => r.name === n);
  if (byName) return byName;
  // 2) id（任务图里的 capability）
  const byId = list.find((r) => r.id === n);
  if (byId) return byId;
  // 3) 加了前缀再试一次：`acceptor` 对不上 id 时，可能是别人的角色目录里 name 不带前缀
  const prefixed = `${agentPrefix || ''}${n}`;
  return list.find((r) => r.name === prefixed) || null;
}

/** 注册表的按名索引，`registry[role].file` 这种用法要的就是它。
 *  键同时含 id 与全名（指向同一条记录）—— 只有一个键的话，调用方又得自己猜是哪一种。 */
export function roleIndex(roles) {
  const idx = {};
  for (const r of Array.isArray(roles) ? roles : []) {
    idx[r.id] = r;
    idx[r.name] = r;
  }
  return idx;
}

/** 显示名：frontmatter 的 `display`，缺省就是 id。
 *
 *  缺省回落 id 而不是内置一张中文表：那张表是第二个必须手工同步的地方，
 *  而它漂了不会有任何东西变红。要中文名，在角色的 frontmatter 写一行 `display:`。 */
export function labelOf(roles, capability) {
  const c = String(capability == null ? '' : capability);
  if (!c) return '—';
  const hit = (Array.isArray(roles) ? roles : []).find((r) => r.id === c || r.name === c);
  return hit ? hit.display : c;
}

/** 某个 id 的**全名**（配置前缀 + id），查不到就原样返回。
 *
 *  用途：给用户看的文案要点名「派哪个角色」，而那个名字不该在文案里写死 ——
 *  换个 `agentPrefix` 之后，写死的 `oversight-planner` 就是一句指向不存在角色的建议。 */
export function nameOf(roles, id, { agentPrefix = DEFAULT_AGENT_PREFIX } = {}) {
  const hit = (Array.isArray(roles) ? roles : []).find((r) => r.id === id || r.name === id);
  return hit ? hit.name : `${agentPrefix || ''}${id}`;
}

// ── 按根求值：项目角色 vs 框架角色 ─────────────────────────────────

/** 一个根的角色目录。`root/.claude/agents`（**不判断存在性**，由 `rolesFor` 判）。 */
export function rolesDirFor(root) {
  const r = String(root || '').trim();
  return r ? join(r, '.claude', 'agents') : null;
}

/**
 * 按**根**取角色注册表。这是「有哪些角色」唯一的对外入口。
 *
 * ## 为什么不能是模块加载时的常量
 *
 * 修前 `validate-run.mjs:52` 是
 *
 *     export const CAPABILITIES = Object.freeze(discoverRoles().map((r) => r.id).sort());
 *
 * 模块级 `const` 在任何 `--root` 解析之前就执行，而 `discoverRoles()` 不带参数
 * → 永远读**框架自己**的 `.claude/agents/`。实测（2026-11-21，`%TEMP%` 下一个
 * 只有 `qa.md` / `reviewer.md` 的真项目）：
 *
 *     capability: "qa"       → exit 1「不在合法取值内」
 *     capability: "executor" → exit 0（项目里根本没有这个角色）
 *
 * 后半句比修前更糟：它让「校验通过」不再意味着「这个角色在项目里存在」。
 * 求值时机是根因，所以修法只能是**按根求值**，不能是「再加一份清单」。
 *
 * ## 合并规则：项目有角色目录 → **只**认项目；没有 → 框架兜底
 *
 * 派单里写的是「项目角色优先，框架兜底」。如果兜底是**逐 id 合并**，那么一个
 * 只有 `qa` 的项目里写 `capability: "executor"` 仍然合法 —— 因为框架有 executor。
 * 那正是本次要修的那半句假话，只是换了个来源。所以这里的兜底是**整份**的：
 *
 *   · `<root>/.claude/agents/` 存在且至少有一个可解析的 `.md` → 用它，**不并入框架**；
 *   · 否则（没有目录 / 空目录 / 不是项目）→ 用框架仓库的注册表。
 *
 * 两种情形都**必须打印来源**：同一句「合法角色：a / b / c」可能来自两个目录，
 * 而「写错角色名」与「看错了哪个项目」在屏幕上是同一个样子。
 *
 * 项目的角色名前缀取项目自己的 `overwatch.config.json`（`agent.agentPrefix`）；
 * 框架兜底时取框架的。**不是同一个值**：本仓是 `oversight-`，别人的项目可能是 `ow-`。
 *
 * ## 框架兜底去哪个目录（DF-062）
 *
 * 「框架角色目录」不是一个常量，而是**按包根探测出来的**（见 `agentsDirCandidates`）：
 * `<pkgRoot>/.claude/agents` 与 `<pkgRoot>/agents` 取第一个**扫得出角色的**。
 * 前者是本仓自用形态，后者是 plugin 载荷形态 —— 两者都是合法的，只是宿主认的布局不同。
 *
 * 每个候选的盘上状态与角色数都记在返回值的 `tried` 里，**角色数为 0 时 `sourceText()`
 * 会逐条打出来**。理由：这个缺陷的原始表现是「12 个角色，认到 0 个」（DF-062），
 * 而只打印最后试的那个位置时，读者看到的是一个不存在的路径，既说不出「它试过什么」，
 * 也看不出「该去建哪个」。
 *
 * @param {string|null} root 用户项目根（`projectRoot()` 的结果）。`null` = 只认框架
 * @param {{agentPrefix?:string}} [opts] 显式前缀（不给就按各自根读配置）
 * @returns {{roles:Array<object>, source:'project'|'framework', dir:string|null,
 *            agentPrefix:string, tried:Array<{dir:string, state:string, count:number}>,
 *            warnings:Array<{code:'notdir', scope:'project'|'framework', dir:string,
 *                             chosen:string|null}>}}
 *   每条 role 额外带 `source`，调用方不必记住整份来自哪。
 *   `tried` 是框架兜底实际试过的候选（项目分支命中时为空数组）；`state` 是
 *   `'dir' | 'notdir' | 'missing'`，`count` 是**那一处**扫出的角色数。
 *   `warnings` 是「盘上坏了」的候选（目前只有 `notdir`）—— **不管最终拿到几个角色都要打印**，
 *   见 `probeAgentsDir` 的 `warnings` 段。`scope` 区分是用户项目里坏了还是框架/载荷里坏了，
 *   两个都要报：只报框架的会让项目里那个继续隐身（而它才是用户手动建的那个）。
 */
export function rolesFor(root, { agentPrefix = null } = {}) {
  const dir = rolesDirFor(root);
  const projectPrefix = agentPrefix != null ? String(agentPrefix) : agentPrefixFrom(root);
  // 项目角色目录**存在但不是目录** → 用户建了、想让脚本读那里，却读不了。
  // 与「项目里没建」不是一回事，所以单独判一眼（`discoverRoles` 对它返回 `[]`，
  // 那个 `[]` 与「空目录」同形，分不出来）。
  const projectWarning = dir && dirStateOf(dir) === 'notdir'
    ? { code: 'notdir', scope: 'project', dir, chosen: null }
    : null;
  if (dir) {
    const list = discoverRoles(dir, { agentPrefix: projectPrefix });
    if (list.length) {
      return {
        roles: list.map((r) => ({ ...r, source: 'project' })),
        source: 'project',
        dir,
        agentPrefix: projectPrefix,
        tried: [],
        warnings: [],
      };
    }
  }
  // 框架兜底：两种布局按优先级取第一个**有角色的**（DF-062）。
  // 前缀一并交给探测 —— id 是「name 去前缀」，前缀不同 id 就不同（见 `probeAgentsDir`）。
  const fwPrefix = agentPrefix != null ? String(agentPrefix) : agentPrefixFrom(REPO_ROOT);
  const probe = probeAgentsDir(REPO_ROOT, { agentPrefix: fwPrefix });
  return {
    roles: probe.roles.map((r) => ({ ...r, source: 'framework' })),
    source: 'framework',
    dir: probe.dir,
    agentPrefix: fwPrefix,
    tried: probe.tried,
    // 项目那一层的坏目录，与框架候选那一层的坏目录，**两个都要报**：
    // 只报框架的会让「项目里那个文件」继续隐身（而它才是用户真正建的那个）。
    warnings: [...(projectWarning ? [projectWarning] : []), ...probe.warnings],
  };
}

/** `rolesFor()` 的 id 投影，顺序稳定（报错信息会原样打给人看）。
 *
 *  这是 `CAPABILITIES` 那个常量的替代品：**同样的数据，但按根求值**。 */
export function capabilitiesFor(root, opts) {
  return rolesFor(root, opts).roles.map((r) => r.id).sort();
}

/** 候选状态的**人话**。判据只有 `state` + `count`，没有猜测。
 *
 *  这一句是 DF-062 整改第 1 条的正身：修前无论实际发生什么，0 个角色一律被说成
 *  「都不存在或为空」—— 而实测里「存在且有 12 个角色、只是排在后面」也被这么描述了，
 *  那是**假话**，且把读者指向「去建目录」这个错误的动作。 */
function describeCandidate({ state, count }) {
  if (state === 'notdir') return '存在但不是目录';
  if (state === 'missing') return '不存在';
  return `${count} 个角色`;
}

/** 一句话说清「这份注册表来自哪」。**每次都要打印** —— 理由见 `rolesFor` 注释。
 *
 *  路径一律经 `displayPath()` 遮罩：提示词与日志会被落盘、会进 transcript，绝对路径
 *  等于把本机目录结构发出去（`checkAbsolutePaths` 守的就是这条）。
 *  **载荷形态下 `dir` 不在 `root` 底下**，所以「相对 `root` 打印」这一条不够 ——
 *  见 `displayPath` 的三级回落。DF-062 的实测输出里就漏了一条
 *  `C:\\Users\\…\\pkg\\.claude\\agents`。
 *
 *  框架兜底、且角色数为 0 时，逐条打印候选的**实际状态**（DF-062）：
 *  「12 个角色，认到 0 个」这种形态，屏幕上必须能看出「它找过哪儿、每个地方看到了什么」。
 *  找到角色时不铺这串清单（那是噪音，且两条路径里必然有一条是无关的）。
 *
 *  **`warnings` 与角色数无关，永远打印**（DF-062 整改，评审打回的那条）：
 *
 *      <pkg>/.claude/agents 是普通文件，<pkg>/agents 有 12 个角色
 *      → 修前输出「（12 个）」、一个字都不提那个坏掉的目录
 *
 *  那是本仓台账里最高频的缺陷形态（**配置坏了但看起来一切正常**）。噪音边界是
 *  「正常形态一个字都不多」：`warnings` 只装 `notdir`，而「目录正常」「目录没建」
 *  都不产生它 —— 上面那串 `试过 …` 仍然只在 0 个角色时才出现。 */
export function sourceText(set, root = null) {
  const s = set && typeof set === 'object' ? set : { source: '?', dir: null, roles: [] };
  const n = Array.isArray(s.roles) ? s.roles.length : 0;
  const where = displayPath(s.dir, root);
  const ws = Array.isArray(s.warnings) ? s.warnings : [];
  const warnText = warnTextOf(s, root);
  // 「用户项目里没有 .claude/agents/」这句只在**项目那一层确实没建、也没坏**时才成立：
  //  · 项目里建了但坏了 → 那是「有，但是个文件」，不是「没有」；由 warnText 说。
  //  · 项目里好好地有角色 → 走的是 project 分支，不会到这儿。
  const projectBad = ws.some((w) => w.scope === 'project');
  if (s.source === 'project') return `项目角色目录 ${where}（${n} 个${warnText}）`;
  const tried = Array.isArray(s.tried) && s.tried.length ? s.tried : null;
  const triedText = (n === 0 && tried)
    ? `；试过 ${tried.map((t) => `${displayPath(t.dir, root)}（${describeCandidate(t)}）`).join(' / ')}`
    : '';
  const fallbackText = projectBad ? '' : '；用户项目里没有 .claude/agents/';
  return `框架角色目录 ${where}（${n} 个${fallbackText}${triedText}${warnText}）`;
}

/** `warnings` 的人话片段（空的 = 一切正常，一个字符都不产生）。
 *
 *  `scope` 决定把话说给谁听：`project` 那条是**用户项目里**的目录坏了（他会去那里加角色），
 *  `framework` 那条是**载荷/包根**里的坏了。两个都说，否则坏掉的那个继续隐身。 */
function warnTextOf(s, root) {
  const ws = Array.isArray(s.warnings) ? s.warnings : [];
  if (!ws.length) return '';
  return ws.map((w) => {
    if (w.code !== 'notdir') return `；⚠ ${displayPath(w.dir, root)}：${w.message || '有问题'}`;
    const where = displayPath(w.dir, root);
    const who = w.scope === 'project' ? '项目' : '框架';
    const use = w.chosen ? `，已改用 ${displayPath(w.chosen, root)}` : '';
    return `；⚠ ${who}角色目录 ${where} 存在但不是目录（配置坏了${use}）`
      + ' —— 往里放的角色不会被读到';
  }).join('');
}

let _default = null;

/** 从仓库根读 `agent.agentPrefix`。**读不出就用默认值**，不抛。
 *
 *  为什么容忍而不是严格校验：这里不是配置校验的入口（那是 `question-audit.mjs` 的
 *  `validateConfig()`，它会把非法值报成错误）。角色注册表只负责「按它取名」，
 *  一份坏配置不该让 `import` 这个模块就炸 —— 结构门要在配置坏掉时**照样能报出别的错**。
 */
export function agentPrefixFrom(root) {
  try {
    const p = join(String(root || resolve(HERE, '..')), 'overwatch.config.json');
    if (!existsSync(p)) return DEFAULT_AGENT_PREFIX;
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    const v = cfg && cfg.agent && cfg.agent.agentPrefix;
    return typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_AGENT_PREFIX;
  } catch { return DEFAULT_AGENT_PREFIX; }
}

/** 仓库自带注册表（懒加载一次）。
 *
 *  懒加载的理由不是性能：模块顶层读盘会让 `import` 一个纯判据也要磁盘就绪，
 *  而结构门会在**几个不同 cwd** 下 import 这些脚本。
 *
 *  目录按 `probeAgentsDir()` 探测（DF-062）；缓存的是**结果**，不是目录 —— 同一个进程里
 *  包根不会变，所以这份缓存不会把两种布局混起来。
 *  前缀一次算清再交给探测（`probeAgentsDir` 要它，`id` 由它决定）。 */
export function defaultRoles() {
  if (_default == null) {
    _default = probeAgentsDir(REPO_ROOT, { agentPrefix: agentPrefixFrom(REPO_ROOT) }).roles;
  }
  return _default;
}
