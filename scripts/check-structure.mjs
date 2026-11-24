#!/usr/bin/env node
/**
 * check-structure.mjs — 仓库结构硬门。
 *
 * 把「本机私有 vs 可发布」的约定变成可执行的检查，而不是靠自觉。
 * 零依赖。CI 里作为硬门运行：失败即 exit 1。
 *
 * 用法：node scripts/check-structure.mjs
 * 退出码：0 = 全部通过；1 = 有违规。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, extname, dirname, resolve } from 'node:path';

import { publishedPathViolations, findKnownIdentifiers } from './published-paths.mjs';
import { scanLinks, KIND_TEXT } from './link-check.mjs';
import { discoverRoles, parseFrontmatter, readonlyOf, bashScopeOf, rolesFor, rolesDirFor } from './roles.mjs';
import {
  loadChecks, livingDocsGap, CONFIG_REL, CHECK_NAMES, CHECK_DOMAINS, domainOf,
  DEFAULTS as CHECKS_DEFAULTS,
} from './check-config.mjs';
import { countRegisteredTests } from './regression-count.mjs';
import { quartetGaps, QUARTET_FIELDS } from './dispatch-quartet.mjs';

const ROOT = process.cwd();
const violations = [];
const warnings = [];

/** 「本条没跑」的收集器。**必须与 violations / warnings 分开** ——
 *  它既不是违规（缺的东西如果是可选的，仓库没坏），也不是提示（提示会淹没在
 *  一堆「导出未登记」里）。 */
const skipped = [];

const fail = (file, msg) => violations.push({ file, msg });
const warn = (file, msg) => warnings.push({ file, msg });

/** 报「某条检查没跑」。这条记录会出现在输出末尾单独一节，**不会**被 `✓` 掩盖。 */
const notRun = (check, why) => skipped.push({ check, why });

/** 「这个产物是**本产品自身**的规定产物，缺了说明仓库坏了」。
 *
 *  ## 为什么需要这个函数（DF-047）
 *
 *  本文件历史上散着 30 处 `if (!existsSync(x)) return;`。它们的共同点是
 *  **缺失即放行**：门打印 `✓ 结构检查全部通过` 而那条检查一个字都没查。
 *  实测（2026-11-21）把 `checkChangelog()` 与 `checkLedger()` 两个 dispatch 调用
 *  从运行块里删掉，硬门照样 `✓` + exit 0，1874 条回归测试全过 ——
 *  **没有任何机制发现这两条检查被删了**。
 *
 *  修法不是把 `return` 一把改成 `fail`：那会让「用户还没有 docs/design/」这类
 *  合法场景变红。语义被拆成三个名字，**调用方必须显式选一个**：
 *
 *    · `requireProduct()` —— 这是**本产品自身**的规定产物，缺了 `fail`。
 *      仅在 `productRepo: true` 时如此（DF-051）；别人的项目里它是 `optional`。
 *    · `optionalPath()` —— 缺了合法，但**必须在输出里留下「本轮没跑」**。
 *
 *  两个名字都是返回 boolean，调用方照旧写 `if (!requireProduct(...)) return;`。
 *  名字本身就是「缺了会怎样」的文档，读代码的人不用去猜。
 *
 *  ## 为什么原来的名字 `requirePath` 被改名（DF-051 的一半）
 *
 *  它的报错文案是「它是本仓库的规定产物」。在别人的项目里，那 54 条违规字面上
 *  就是**要求对方复制我们整套文档**。名字与文案都带着「本仓库」这个假设，
 *  于是调用点看不出自己把「我们自己的规矩」当成了「任何项目的合格线」。
 *  改名 + 拆域之后，**每个调用点必须回答「这是通用命题还是我们的规矩」**。 */
function requireProduct(abs, label) {
  if (existsSync(abs)) return true;
  // 别人的项目里，我们的产物没有对象 —— 但不能静默：登记「本轮没跑」。
  //
  // **按检查聚合，不逐份报**：`livingDocs` 一份清单就是 16 个文件，逐条打印会让
  // 「3 条违规」后面跟 40 行「未跑」，读者只会去关掉这道门。聚合成一条的意思是
  // 「这条检查的覆盖面比它的名字窄」，那才是要传达的事实。
  if (!PRODUCT_REPO) {
    productMissing.set(CURRENT_CHECK, (productMissing.get(CURRENT_CHECK) || 0) + 1);
    return false;
  }
  fail(label, '不存在 —— 它是本产品自身的规定产物，缺了说明仓库结构已损坏（这条检查因此没跑）');
  return false;
}

/** 「这个产物是**任何项目**都该有的（脚本目录 / README / .gitignore）」。
 *
 *  与 `requireProduct()` 的区别是适用范围，不是严重程度：脚本目录缺失在任何项目里
 *  都是真问题（那里的检查无从谈起）。`PRODUCT_REPO` **不改变**这一条 —— 这正是
 *  「分三档」里第一档「真问题」的落点。 */
function requirePath(abs, label) {
  if (existsSync(abs)) return true;
  fail(label, '不存在 —— 缺了它，这条检查没有可查的对象（这不是「可跳过」）');
  return false;
}

/** 「缺了是合法的（用户没建 / 可选能力），但**不许静默**」。
 *
 *  返回 false 时同时登记一条「本轮没跑」，于是读者的输出里会看到
 *  `— 2 条检查未跑`，而不是误以为那一条也通过了。 */
function optionalPath(abs, check, why) {
  if (existsSync(abs)) return true;
  notRun(check, why);
  return false;
}

// ── 形状配置（`.untildone/checks.json`，可缺省）──────────────────────────
//
// 「哪些目录算可发布 / 哪些是私有 / 角色目录在哪」原先全是常量。那让本仓库以外
// 的项目**跑一次就红一片**，而红的不是它们的问题（实测见
// `tasks/dev-findings.md` DF-046）。这里改成：**没有配置文件 = 用默认值 = 本仓库现状**，
// 所以本仓库一个字节都不用写；别人写一份就换掉形状。
//
// 配置本身非法时**不静默回落**：报违规、继续用默认值跑 —— 这样其余 23 条检查
// 照样能报出别的错，而「配置坏了」这件事不会被一条无关的红盖住。
const CHECKS_LOAD = loadChecks(ROOT);
const CFG = CHECKS_LOAD.config;
for (const e of CHECKS_LOAD.errors) {
  fail(e.path ? `${CONFIG_REL}: ${e.path}` : CONFIG_REL, `配置非法：${e.msg}`);
}
// 只有当配置**改变了行为**时才打印一行：本仓库那份配置与默认值逐字相同，
// 所以这一行在本仓不出现 —— 这是「本仓输出字节级不变」的一部分（可验证，不是承诺）。
// 换掉形状的项目则一定看得见「配置在生效」，否则「我写了配置却没生效」无从分辨。
//
// 比较用**排序后的键**：`validateChecks()` 补默认值时按自己的遍历顺序塞键，
// 与 `DEFAULTS` 的字面顺序不同（实测第一次写成直接 stringify，本仓因此多打一行）。
const canon = (o) => JSON.stringify(o, (_k, v) => (
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
    : v));
const cfgChanged = canon(CFG) !== canon(CHECKS_DEFAULTS);
if (CHECKS_LOAD.source === 'file' && cfgChanged) {
  console.log(`配置：${CHECKS_LOAD.path}（形状与默认值不同，以下检查按它执行）\n`);
}

/** **本仓是不是本产品自身的仓库**。整个「分域」的开关（DF-051）。
 *
 *  `false`（默认）时，`product` 域的检查不执行、也不报「规定产物不存在」——
 *  别人的项目不欠我们一份 CHANGELOG、一份 `docs/design/`、一句「不能自动接力」。
 *  `true` 时按产品自身的全部规矩自检（本仓库那份配置写着 `true`）。
 *
 *  **不可静默**：`false` 时输出末尾会列一行「哪一族规矩本轮不适用 + 怎么打开」——
 *  否则「本产品规矩全部通过」与「本产品规矩一条都没跑」在屏幕上同形（DF-047 的老病）。 */
const PRODUCT_REPO = CFG.productRepo === true;

/** 当前正在执行的检查名。`requireProduct()` 要用它登记「本轮没跑」。
 *  运行循环每进一条就赋一次 —— 这样每个调用点不必自己传名字（传错的话
 *  「未跑」会记到别人头上，而那种错没有任何机制发现）。 */
let CURRENT_CHECK = '(init)';

/** 检查名 → 因「本产品自身的产物不存在」而没跑的次数（`productRepo=false` 时）。
 *  按检查聚合成一行输出，理由见 `requireProduct()`。 */
const productMissing = new Map();

// ── 规则定义 ──────────────────────────────────────────────────────────

/** 可发布区：出现本机盘符即为违规（ADR-0001 §发布区零盘符） */
const PUBLISHED_DIRS = CFG.publishedDirs;
/** 根级文件同属可发布区。
 *
 *  `SECURITY.md` 曾不在这里 —— 它是**最该被扫的那一份**：安全披露文档天然会把
 *  攻击面写成具体路径（「`scripts/x.mjs` 的这一段会被注入」），一旦抄进本机绝对路径，
 *  泄漏的既是身份也是可打击点。审计指出它不在扫描范围内（`DF-039`）。
 *
 *  修法不是「把 SECURITY.md 加进这个数组」，而是**根级 `.md` 一律自动纳入**：
 *  手写清单的失效方式是结构性的 —— 下一次有人加一份根级文档，它照样不在名单里，
 *  而门照样绿。这与 `checkTestCount()` 拒写死数字是同一个理由。
 *  这个数组只留「非 `.md` 但必须扫」的例外。 */
const PUBLISHED_FILES_EXTRA = ['LICENSE'];
/** 根级目录不扫（产物 / 依赖 / 私有台账），其余根级文件按扩展名决定。 */
const ROOT_SCAN_SKIP = new Set(['node_modules', 'dist', 'tasks', 'local', '.git']);

/** 私有区：允许出现本机路径，但必须被 .gitignore 排除 */
const PRIVATE_PATHS = CFG.privatePaths;

/** 允许出现盘符的文件（本机私有、运行时产物） */
const PATH_EXEMPT = new RegExp(`^(${CFG.scriptsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*\\.test\\.mjs)$`);

/** 角色目录与脚本目录。**所有用到它们的地方都从这里取** —— 写死一处就等于没参数化：
 *  `%TEMP%` 里那个项目把脚本放在 `src/`，写死 `join(ROOT,'scripts')` 的 6 处检查会
 *  对着一个不存在的目录静默 `return`，门报绿而一个字都没查。
 *
 *  ## 角色目录**不再是一个配置键**（DF-064）
 *
 *  修前这里有三个答案：`checks.json` 的 `agentsDir`（硬门用）、
 *  `roles.mjs` 的 `agentsDirCandidates()` 探测（运行期用）、以及宿主自己加载的
 *  `项目根/.claude/agents/`。三者可以各不相同，而**没有一个机制发现它们分叉了**。
 *
 *  现在角色目录只有一个来源：`roles.mjs` 的 `rolesDirFor(root)`（= `<root>/.claude/agents`）。
 *  硬门、`validate-run`、`compose`、`render-plan` 全部读它；宿主读的也是同一个路径 ——
 *  那是 Claude Code 的项目布局约定，不是我们能换的东西。于是「角色在哪」不可能再有两个答案。 */
const SCRIPTS_DIR = join(ROOT, CFG.scriptsDir);
/** 报告里用的相对路径（`scripts/x.mjs` 这种），**所有报错文案都从这里取** ——
 *  文案里写死的 `scripts/` 在别人的项目里是一条指向错地方的指示。 */
const SCRIPTS_REL = CFG.scriptsDir;

/** 角色目录：**来自 `roles.mjs`，不是本文件的一个常量**（DF-064）。
 *
 *  `rolesDirFor(ROOT)` 就是 `<root>/.claude/agents` —— 与宿主加载项目角色用的是
 *  同一个路径。硬门不再有自己的 `agentsDir` 答案，所以「门说角色在 A、派发器去 B 找」
 *  这种分叉在结构上不可能发生。相对路径由 `relative()` 算，不手写，免得换布局时漂。 */
const AGENTS_DIR = rolesDirFor(ROOT);
const AGENTS_REL = relative(ROOT, AGENTS_DIR).replace(/\\/g, '/');

const AGENT_REQUIRED_FIELDS = ['name', 'description'];
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash'];

// ── 工具函数 ──────────────────────────────────────────────────────────

function walk(dir, out = []) {
  // 遍历器本身不是检查：调用方**必须**先判「这个目录该不该存在」再调它。
  // 留静默是因为它对「已确认存在的目录」是纯工具函数 —— 但正因如此，
  // 用它之前不许用 `existsSync` 当守卫（那会把「不存在」变成空结果，与「目录是空的」同形）。
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

/** 只作为 CLI 运行、不导出函数的脚本。它们被 import 会执行副作用。
 *
 *  `verify-bugfix-negatives.mjs` 会**改写源码再还原**（负向验证），必须只当 CLI 用，
 *  绝不能被结构门自动 import 并调用。`gen-width-table.mjs` 不在此列：它的解析/渲染
 *  函数是纯的，测试直接 import 它们做对照，所以下面照常登记。 */
const CLI_SCRIPTS = new Set(['check-structure.mjs', 'check-links.mjs', 'verify-bugfix-negatives.mjs', 'verify-tui-negatives.mjs', 'verify-claim-fix-negatives.mjs']);

/** 解析 frontmatter 的**唯一实现**已搬到 `scripts/roles.mjs`（2026-11-21，DF-044）。
 *
 *  为什么是搬走而不是在两边各留一份：本文件原先有一份拷贝，`compose-agent-prompt.mjs`
 *  另有一份。两份对多行块的处理一致只是当时的巧合；而「角色有没有声明只读」现在
 *  两边都要读 —— 一个解析差异就会让硬门放行、compose 拦下，同一份文件两个结论。
 */

function isGitignored(path) {
  const gi = join(ROOT, '.gitignore');
  // 返回 false = 「没有任何规则忽略它」。**这个默认值本身是一条判断**：
  // `.gitignore` 缺失时，`checkGitignoreSanity()` 会 fail（它是规定产物），
  // 所以这里不需要重复报错；但把「读不到规则」当成「没被忽略」是**保守方向**
  // 的正确选择 —— 它会让 `checkPrivatePaths()` 更可能报红，而不是更不可能。
  if (!existsSync(gi)) return false;
  const lines = readFileSync(gi, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return lines.some((rule) => {
    const r = rule.replace(/^\//, '');
    return path === r || path.startsWith(r.replace(/\/$/, '') + '/') || path === r.replace(/\/$/, '');
  });
}

/** 「这个根级文件会不会随仓库发出去」——即 git 眼里的可发布集。
 *
 *  不用 `isGitignored()` 判：那个函数只做精确/前缀匹配，不展开 glob，而 `.gitignore`
 *  里恰恰全是 glob（`.tmp-*`、`dist/`、`*.log`）。实测漏判：根目录下一个 `.tmp-qa.json`
 *  （另一个会话的草稿）被判成「可发布」，硬门于是报了一条跟产品毫无关系的违规。
 *
 *  可发布区的定义本来就是「会随仓库发出去的内容」，那就让 git 回答：
 *  已跟踪的 + 未跟踪但未被忽略的。干净 clone 上这两种恰好等于仓库里的全部文件。
 *  不是 git 仓库（解压后的发布包）时返回 null，调用方退化为「按扩展名扫全部」。 */
function gitPublishableRootFiles() {
  const run = (args) => {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout || '') : null;
  };
  const tracked = run(['ls-files', '-z']);
  if (tracked === null) return null;
  const untracked = run(['ls-files', '--others', '--exclude-standard', '-z']) || '';
  const out = new Set();
  for (const rec of (tracked + untracked).split('\0')) {
    if (!rec) continue;
    const name = rec.replace(/\\/g, '/');
    if (name.includes('/')) continue;          // 只看根级
    out.add(name);
  }
  return out;
}

// ── 检查 1：可发布区零盘符 ────────────────────────────────────────────

/** 判据本体在 `scripts/published-paths.mjs`（纯函数，有单测）。
 *  这里只负责「扫哪些文件、怎么报」。
 *
 *  **为什么把正则搬出去**：原先它写在这个文件里，而 `check-structure.mjs` 一被 import
 *  就跑完全部门禁并 `process.exit()`，于是它**一条测试都写不了**。结果是一个只认 7 个
 *  固定前缀（`Users|Projects|Server|Java|maven|Nodejs|Git`）的正则在这里活了很久，
 *  凡是不在这 7 个前缀下的本机路径全部漏过，硬门照绿（`DF-039`）。
 *  判据搬出去之后，「正则漏了某个形态」会直接红在测试上。
 *  具体漏过的字面量写在 `published-paths.test.mjs`（测试文件被 `PATH_EXEMPT` 豁免）。
 */
function checkAbsolutePaths() {
  const targets = [];

  for (const d of PUBLISHED_DIRS) {
    // 可发布区里的目录**不是每条都必须存在**：`rules/` 与 `spec-adr/` 是
    // 从参考项目继承来的名字，本仓库从来没有过这两个目录（`ls` 实测）。它们是
    // 「若存在就扫」的集合，不是「必须存在」的清单 —— 缺了不报违规，但也**不静默**：
    // 记一条「本轮没扫它」，让读者知道覆盖面比名单窄。
    if (!optionalPath(join(ROOT, d), `absolutePaths:${d}`, `可发布目录 ${d}/ 不存在，未扫`)) continue;
    targets.push(...walk(join(ROOT, d)));
  }
  // 根级文件：会随仓库发出去的那些，全部自动纳入（含 SECURITY.md / README-EN.md）。
  //
  // **判「会不会发出去」用 git，不用手写清单、也不用 `isGitignored()`**：
  //  - 手写清单的失效方式是结构性的（加一份根级文档，它就不在名单里，门照样绿）——
  //    与 `checkTestCount()` 拒写死数字是同一个理由；
  //  - `isGitignored()` 不展开 glob，实测把一个 `.tmp-qa.json` 草稿判成「可发布」，
  //    硬门于是报了一条跟产品毫无关系的违规。
  const publishable = gitPublishableRootFiles();
  const rootFiles = publishable
    ? [...publishable]
    : readdirSync(ROOT).filter((f) => !ROOT_SCAN_SKIP.has(f) && !isGitignored(f));
  for (const f of [...PUBLISHED_FILES_EXTRA, ...rootFiles]) {
    const p = join(ROOT, f);
    // 这一处的 `continue` **不是**静默短路：`f` 来自 git 的可发布清单，
    // 名字出现在清单里而盘上不在，只可能是「已跟踪但被删且未提交」。
    // 那种情况由 git 自己报，且它**不是本检查的判据**（本检查判的是泄漏）。
    // `PUBLISHED_FILES_EXTRA`（`LICENSE`）同理：它是「若存在就必须扫」的例外名。
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    if (!['.md', '.mjs', '.js', '.json', '.yml', '.yaml', '.txt'].includes(extname(f))) continue;
    targets.push(p);
  }
  if (existsSync(AGENTS_DIR)) {
    targets.push(...walk(AGENTS_DIR));
  }

  for (const file of targets) {
    const r = rel(file);
    if (PATH_EXEMPT.test(r)) continue;
    if (!['.md', '.mjs', '.js', '.json', '.yml', '.yaml', '.txt'].includes(extname(file))) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    // 逐个报「行号 + 路径」，不再报「第几次出现」。旧版的 `text.split('\n').find(l => l.includes(h))`
    // 取的是**第一个含该子串的行**，于是同一个路径在文件里出现十次时，九次的真实位置丢失。
    for (const v of publishedPathViolations(text)) {
      fail(r, `第 ${v.line} 行出现本机绝对路径：${v.path.slice(0, 90)}`
        + '（改成 `<repo>` / `D:\\…` 这类占位符，或放进 tasks/ 私有区）');
    }
    // 第二个判据：**没有盘符前缀**的本机标识符。上面那条正则认的是「盘符 + 分隔符」，
    // 而 TUI 的路径副行只印目录尾段 —— 真实中文项目名可以整串裸奔在文档里。
    // 这里**故意不回报原文**：回报等于把泄漏重复一遍到硬门输出与 CI 日志里。
    for (const v of findKnownIdentifiers(text)) {
      fail(r, `第 ${v.line} 行出现已知的本机标识符（无盘符前缀，故路径判据抓不到）。`
        + '改成同形态假名，或在截图旁声明项目名已脱敏');
    }
  }

  // 台账（`tasks/`）单列：**只跑标识符判据，不跑路径判据。**
  //
  // 为什么不跑路径判据：台账里存的是**脱敏后的对照夹具**（盘符 + 假目录名、
  // 假 SDK 安装根、假应用安装位），它们是「改成了什么」的证据，不是本机事实。
  // 对它们报违规只会逼人把证据也删掉。
  //
  // 为什么标识符判据必须覆盖台账：台账在可发布区（CLAUDE.md 目录归属表标「是」），
  // 且**被 git 跟踪**。上一轮的判断（「`tasks/` 不在扫描范围，所以留原文没事」）只对了一半：
  // 范围外只是「门不管」，而门不管的文件照样随公开仓库发出去 —— 那正是把泄漏从一份文件
  // 搬到另一份。这一条由 `DF-039` 第二轮的实事故钉住。
  for (const f of ['tasks/dev-findings.md', 'tasks/accepted-deviations.md']) {
    const p = join(ROOT, f);
    // 两本台账是**本产品自身**的规定产物（CLAUDE.md 目录归属表把它们列为可发布区）。
    // 缺了不是「可跳过」，是「台账没了，纪律的载体也没了」—— 本产品自己的仓库里报违规。
    // 别人的项目里不要求它们存在（DF-051）—— 但**存在就照查**：
    // 如果有人在自己的项目里也建了同名台账，泄漏判据照样适用。
    if (!requireProduct(p, f)) continue;
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    for (const v of findKnownIdentifiers(text)) {
      fail(f, `第 ${v.line} 行出现已知的本机标识符。台账也随仓库发布 ——`
        + '把原文写进台账 = 把泄漏搬到隔壁文件');
    }
  }
}

// ── 检查 2：私有区必须被 .gitignore 排除 ──────────────────────────────

function checkPrivatePaths() {
  for (const p of PRIVATE_PATHS) {
    const full = join(ROOT, p);
    // 私有路径**本来就可能不存在**：`local/`、`CLAUDE.local.md` 是「如果你建了它，
    // 它必须被忽略」的规则，不是「你必须建它」。缺了合法 —— 但缺的每一条都要说出来，
    // 否则「4 条私有路径全部合规」与「4 条里有 3 条根本不在盘上」在屏幕上同形。
    if (!optionalPath(full, 'privatePaths', `私有路径 ${p} 不存在，跳过它的 gitignore 判定`)) continue;
    if (!isGitignored(p)) {
      fail(p, `私有路径未在 .gitignore 中排除，可能被误提交`);
    }
  }
}

// ── 检查 3：.gitignore 不得排除产品本体 ───────────────────────────────

function checkGitignoreSanity() {
  const gi = join(ROOT, '.gitignore');
  // `.gitignore` **不是**「本产品规定产物」，但它也不是任何项目的必需品：
  // 一个还没有任何私有路径、也没排除过产品本体的项目，没有它是**安全**的 ——
  // 没有规则 = 什么都不会被误排除。要求它存在等于要求对方长成我们的样子（DF-051）。
  //
  // 判据改成正向的：**需要它的那些条件不成立时，缺了才红**。三条，都来自盘上的事实：
  //   1. 有私有路径在盘上 → 它们必须被忽略（否则 `git add -A` 会把它们提交）；
  //   2. 有运行台账目录在盘上 → 同上（台账含会话 ID，比「私有」更硬）；
  //   3. 有 `gitignoreFatal` 里的目录在盘上 → 必须显式确认没被排除。
  // 只有 1、2 是通用命题（私有物必须被忽略）；3 是**本产品自身的**规矩
  // （「别让 `git add -A` 静默什么都不加」的教训来自那个参考项目），
  // 所以在别人的项目里它不参与「缺了就红」的判断。
  if (!existsSync(gi)) {
    const present = PRIVATE_PATHS.filter((p) => existsSync(join(ROOT, p)));
    const runsHere = existsSync(join(ROOT, CFG.runsDir));
    if (present.length || runsHere) {
      fail('.gitignore', `不存在，而盘上有 ${present.length} 条私有路径`
        + `${runsHere ? `、运行台账目录 ${CFG.runsDir}/` : ''} —— 它们会被误提交`);
    } else {
      notRun('gitignoreSanity', '没有 .gitignore，盘上也没有需要它保护的私有路径或运行台账');
    }
    return;
  }
  const text = readFileSync(gi, 'utf8');
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

  // 参考项目的 .gitignore 忽略 .claude/ rules/ tasks/ —— 对本仓库是致命的。
  // 这一条**只在本产品的仓库里判**：`gitignoreFatal` 是我们在那个项目上付的学费，
  // 别人的项目忽略 `docs/` 完全可能是对的（他们根本没有需要发布的 docs）。
  if (PRODUCT_REPO) {
    const fatal = CFG.gitignoreFatal;
    for (const dir of fatal) {
      const offending = lines.find((l) => {
        const r = l.replace(/^\//, '').replace(/\/$/, '');
        return r === dir || r === dir + '/**' || r === dir + '/*';
      });
      if (offending) {
        fail('.gitignore', `排除了产品本体目录 "${dir}"（规则：${offending}）——git add -A 会静默什么都不加`);
      }
    }
  }

  // 「台账必须被 gitignore 排除」是**通用**命题：台账含会话 ID，任何项目里
  // 误提交都是泄漏。落点跟着配置走（写死 `tasks/runs` 时别人的项目会为
  // **本仓库的**台账目录报红，而它自己真正的台账目录没人看）。
  //
  // 但只在台账目录**在盘上**时才要求：别人的项目可能根本不用运行台账，
  // 那时「必须排除一个不存在的目录」是一条没有对象的红（DF-051）。
  if (existsSync(join(ROOT, CFG.runsDir)) && !lines.some((l) => l.includes(CFG.runsDir))) {
    fail('.gitignore', `未排除 ${CFG.runsDir}/（运行台账可能含会话 ID）`);
  }
}

// ── 检查 4：agent frontmatter ─────────────────────────────────────────

function checkAgents() {
  const dir = AGENTS_DIR;
  // 角色目录在**任何**项目里都是可判的：有 `.md` 就得有合法的 frontmatter
  // （`name` / `description` / `readonly`），只读角色不许拿写工具。
  //
  // 但「**必须存在**」是本产品自身的规矩（12 份定义是被 git 跟踪的交付物）——
  // 别人的项目不配 agent 是正常的，不是仓库坏了。所以缺了用 `requireProduct()`：
  // 本仓里红，别人的项目里记一条「本轮没跑」（DF-051）。
  //
  // 旧版的 `warn(...)` + `return` 是本文件里最典型的一次「静默短路」：
  // 提示不阻塞，而提示出现在末尾那一节，读者扫一眼 `✓` 就走了。
  // 更糟的是它写着「本轮允许」—— 那句话是历史遗留（Phase B 之前的临时状态），
  // 现在它只会让「角色定义全部消失了」看起来像一条无害的提示。
  if (!requireProduct(dir, AGENTS_REL)) return;

  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  if (!files.length) fail(AGENTS_REL, '目录存在但没有任何 agent 定义');

  for (const f of files) {
    const p = join(dir, f);
    const text = readFileSync(p, 'utf8');
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) { fail(rel(p), '缺少 YAML frontmatter'); continue; }

    const fm = m[1];
    const parsed = parseFrontmatter(fm);
    for (const field of AGENT_REQUIRED_FIELDS) {
      if (!parsed[field]) {
        fail(rel(p), `frontmatter 缺少必填字段 "${field}"`);
      }
    }

    // 只读角色的工具白名单不得含写工具。
    // 例外：Write 允许存在（只读角色需要写报告），但必须在正文里声明只能写报告路径。
    //
    // **判据是 frontmatter 的 `readonly: true`，不是名字。** 原实现是
    // `READONLY_ROLES.some((r) => name.toLowerCase().includes(r))` —— 子串匹配。
    // 它的失效方式不是漏检，是**误检且说不清**：用户建一个 `my-review-helper`，
    // 因为名字含 `review` 被当成只读角色，报错说「只读角色 my-review-helper 拥有写工具」，
    // 而这个角色的正文里从没写过它是只读的 —— 用户拿到一句话，不知道改哪里。
    // 申明改成数据之后，「为什么它被当成只读」永远只有一个答案：那份 .md 里写了 readonly: true。
    //
    // 代价（如实记下）：没写 `readonly:` 的文件不再被检查。所以缺这一行本身要报错 ——
    // 否则「忘了写」的失效方式是**静默放行**，比误检更坏。12 份现有定义已全部补齐。
    const name = parsed.name || f.replace(/\.md$/, '');
    if (parsed.readonly === undefined || parsed.readonly === '') {
      fail(rel(p), 'frontmatter 缺少必填字段 "readonly"（true = 该角色不得修改交付物）。'
        + '写不出这一行就说明没人想过这个角色该不该有写权限');
    }
    const isReadonly = readonlyOf(parsed);
    if (isReadonly && parsed.tools) {
      const tools = parsed.tools.split(',').map((t) => t.trim());
      const bad = tools.filter((t) => WRITE_TOOLS.includes(t));
      if (bad.length) {
        const declaresReportOnly = /只允许写|只能写|只写报告|报告路径|不得修改/.test(text);
        // `bashScope`（2026-11-23，`oversight-verifier`）：只读角色跑只读命令的唯一合法出口。
        //
        // 规则本身**没有放松**：修前「readonly + Bash」一律违规；修后要求
        //   ① frontmatter 写 `bashScope: read-only`，**且**
        //   ② 正文有一节「允许的命令」列出具体命令。
        // 两条缺一条照样红。判据挂在 `bad.includes('Bash')` 上而不是先把它从 `bad` 里
        // 摘掉：先摘掉的话，「没写 bashScope」时的报错会变成「拥有写工具 Edit」——
        // 而真正的原因是 Bash，报错指错了地方。
        const bashScoped = bashScopeOf(parsed) === 'read-only';
        const scopedOnlyBash = bad.every((t) => t === 'Bash');
        if (bashScoped && scopedOnlyBash && declaresReportOnly) {
          if (!/##\s*允许的命令/.test(text)) {
            fail(rel(p), `只读角色 "${name}" 声明了 bashScope: read-only，但正文没有「## 允许的命令」一节 —— `
              + '`bashScope` 是一句自我声明，命令清单才是可核对的边界。缺了它，'
              + '「只读」与「不受限的 Bash」在文件外观上同形');
          }
        } else if (!declaresReportOnly) {
          fail(rel(p), `只读角色 "${name}" 拥有写工具：${bad.join(', ')}，但正文未声明只能写报告`);
        } else if (bad.includes('Edit')) {
          fail(rel(p), `只读角色 "${name}" 不得拥有 Edit（Write 仅限写报告，且须靠外壳检查兜住）：${bad.join(', ')}`);
        } else if (bad.includes('Bash') && !bashScoped) {
          fail(rel(p), `只读角色 "${name}" 拥有 Bash，但没有在 frontmatter 声明 "bashScope: read-only" —— `
            + '只读角色跑命令的唯一合法形态是「显式声明只读范围 + 正文给命令清单」，'
            + '不写就与「不受限的 Bash」同形。要么删掉 Bash，要么补上这两处');
        }
        // Bash 以外的写工具（Write / NotebookEdit）仍然按原来的路径判：它们不在
        // `bashScope` 的覆盖范围内，声明了范围也不该获得它们。
        const nonBash = bad.filter((t) => t !== 'Bash');
        if (bashScoped && nonBash.length && !/只允许写|只能写|只写报告|报告路径|不得修改/.test(text)) {
          fail(rel(p), `只读角色 "${name}" 拥有除 Bash 之外的写工具：${nonBash.join(', ')}`
            + '—— bashScope 只覆盖 Bash，不覆盖它们');
        }
      }
    }

    // 描述不能为空（支持多行块）
    if ((parsed.description || '').length < 10) {
      fail(rel(p), 'description 过短，主线程无法据此路由');
    }
  }
}

// ── 检查 5：无空目录 ──────────────────────────────────────────────────

/** 只检查「会被提交的」目录。
 *
 *  gitignore 里的目录根本进不了仓库，对它报「clone 后会消失」是没有意义的：
 *  它 clone 后本来就不存在，不是消失。真实误报：`.tmp-analysis/` 下某个第三方
 *  仓库的 `vendor/<pkg>` 是空的，硬门直接判红，而那一整棵树都在 `.gitignore` 里。
 *
 *  跳过整棵被忽略的子树（而不是只跳过报错的那一层）—— 既省掉数千个文件的遍历，
 *  也让「临时目录里有什么」不再影响结构门。 */
function checkEmptyDirs(dir = ROOT, depth = 0) {
  if (depth > 6 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (['.git', 'node_modules', '.gitkeep'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (depth > 0 && isGitignored(rel(full))) continue;
    const children = readdirSync(full);
    if (children.length === 0) {
      fail(rel(full), '空目录不会被 git 跟踪，clone 后会消失——要么放文件，要么别建');
    } else {
      checkEmptyDirs(full, depth + 1);
    }
  }
}

// ── 检查 6：README 能力边界声明 ───────────────────────────────────────

function checkCapabilityDisclosure() {
  const readme = join(ROOT, 'README.md');
  // `README.md` 是本仓库的规定产物：它是唯一一条对外入口。
  // 旧版 `warn('尚不存在')` 让这个门在「README 被删了」时仍然印 `✓`。
  if (!requirePath(readme, 'README.md')) return;
  const text = readFileSync(readme, 'utf8');
  if (!/不能自动接力|无法自动接力|manual/.test(text)) {
    fail('README.md', '缺少能力边界声明（必须写明本库不能自动接力，见 ADR-0002 §4）');
  }
}

// ── 检查 6.5：文档里的测试数必须与实测一致 ────────────────────────────

/** 本仓规定的**自证位置**：文档里「N 条回归测试」这句话出现在哪、取哪个捕获组。
 *
 *  只查**声明基线**的那一处，不查历史条目（CHANGELOG 与 research 里的旧数字是
 *  事实记录，不该被改）。
 *
 *  第三列 `required`：**声明了就必须对**，但没声明不报违规。
 *  这个区分来自 DF-046（「6 个常量把本仓库的形状当成了判据」）：别人项目里没有徽章，
 *  强制它「必须有一个」会在那个项目里造一条与本门目的无关的红。
 *  前四处仍是必需的 —— 它们是本仓规定的自证位置，缺了等于没人再核这个数。
 *
 *  **这份清单只有一份。** `checkTestCount()` 与 `checkNoExecutionClaims()`
 *  读同一份 —— 两处各写一份必然漂，而「同一件事有第二个答案」正是本仓库反复
 *  吃亏的形态（见 `DF-076`）。 */
const TALLY_SITES = [
  ['README.md', /（(\d+)\s*条回归测试/, true],
  // README 的徽章是**第五处**，原先完全不在核对范围内 —— 只能靠人记得手改，
  // 而它恰恰是访客最先看到的那个数。加进来之后它与其余四处同源（漂了会红），
  // 但对没有徽章的项目不作要求。
  ['README.md', /regression%20tests-(\d+)/, false],
  ['CLAUDE.md', /全量回归测试（(\d+)\s*条/, true],
  // 这一处（GUIDE）**改过口径**：原先取的是 `(\d+)\s*项全绿`，那个正则本身就在
  // 逼文档写「全绿」（DF-090：正则的形状决定了文档必须说什么）。
  // 现在取「N 条已注册」—— 与其余四处同一个命题（有多少条测试存在），
  // 而不是一个本门核不了的命题（它们此刻是否通过）。
  ['docs/GUIDE.md', /(\d+)\s*条已注册/, true],
  ['.github/workflows/validate.yml', /全部回归测试（(\d+)\s*条/, true],
];

/** 回归测试数曾同时存在四个值：README 508 / CLAUDE 192 / GUIDE·CI 81 / 设计稿 588，
 *  实测 793。四份文件四个值，而 CI 里那个 81 停在一年前的量级。
 *
 *  这不是笔误，是**同类缺陷的结构性复发**：只要数字是手写的，下一次加测试又会漂。
 *  所以这里不写死任何一个数字，而是**取实测值**再与文档比对。写错了硬门直接红 ——
 *  那种红是好事：它把「改文档」变成一次必做的动作。
 *
 *  ## 口径换过一次：数源码 → 数真实注册（2026-11-21）
 *
 *  旧版数的是源码里 `^\s*test(` 的字面量。它守的是「文档与**源码字面量**一致」，
 *  而文档声称的是「N 条回归测试」—— 两件事在有循环注册时不是一回事：
 *
 *      for (const cmd of ['scan', 'verify', 'tui', 'watch']) test(`ro 路由：${cmd} …`, …);
 *
 *  `overwatch.test.mjs:305` 就是这一行，一个 `test(` 字面量注册出 **4** 条测试。
 *  于是旧门坚持 1873，而 `node --test scripts/` 报 1876：**这道门在逼文档写一个错的数**，
 *  读者照着文档核对时会以为自己数错了。`count-equals-source` 这条原语当天就产出了
 *  一句假话（红队原话）。
 *
 *  现在改成 `regression-count.mjs` 里的 `countRegisteredTests()`：把 `node:test` 换成一个
 *  只记账的替身再 import 每个测试文件，数它们**真的注册了几条**。这与 `node --test`
 *  的 `ℹ tests` 逐条相等，且不用真跑用例。
 *
 *  ## 这个数平台相关吗（2026-11-21 复核：不相关）
 *
 *  一次 CI 红被归因成「`skip: process.platform !== 'win32'` 让真实注册数平台相关」。
 *  那个归因是错的：`skip` 只决定**跑不跑**，被 skip 的用例照样在 import 时注册、
 *  照样进 `ℹ tests` 总数。实测 CI（Ubuntu/Node 20）与本地（Windows/Node 26）报的
 *  都是 **1906**；伪造 `process.platform` 逐个平台复数也全是 1906。
 *  真正的成因是**加了一条测试没改四份文档**。
 *
 *  与代码同生的那条不变性断言在 `regression-count.test.mjs`（跨平台同数）；
 *  本门在判红时把另一平台的实测数写进报错，免得下一次又被归因成平台差异。
 *
 *  ## 代价（实测，不是估计）
 *
 *  结构门 3.1s → 3.8s（+0.7s，一次子进程；跑全量测试要 52s，所以不能那么做）。
 *  `countRegisteredTests()` 自己的返回值里带 `errors`，**import 失败必须报红**：
 *  一个 import 就炸的测试文件，全量测试里那几条根本不会出现，静默把它算成 0 条
 *  会让这道门从「守数字」退化成「守一个更小的数字」。 */
function checkTestCount() {
  const dir = SCRIPTS_DIR;
  // 脚本目录是规定产物：缺了说明仓库坏了，不是「没有可数的东西」。
  // 旧版的 `return` 在这里有一个更尖锐的后果 —— 数不出条数时门会**照样绿**，
  // 而「回归测试数对账」正是本仓库最常被引用的那一条自证。
  if (!requirePath(dir, SCRIPTS_REL)) return;
  // 超时给足：注册 48 个文件、1900+ 条测试是一次真实的全量 import，
  // 在并发负载下（多个 agent 同时跑测试）实测会超过 60 秒的默认值。
  // 超时的表现是「探针没有回话」，与「探针坏了」同形 —— 那会让人去修一个没坏的东西。
  const measured = countRegisteredTests(dir, { timeoutMs: 180000 });
  if (measured.error) {
    // 「数不出来」不等于「数出来是 0」。旧版在这条路上 `return`（静默放行），
    // 那正是最坏的失效方式：门绿了，而它什么都没核。
    fail(SCRIPTS_REL + '/', `数不出回归测试条数：${measured.error}`
      + (measured.detail ? `（${measured.detail}）` : ''));
    return;
  }
  if (measured.errors && measured.errors.length) {
    for (const [f, msg] of measured.errors) {
      fail(`${SCRIPTS_REL}/${f}`, `import 时就抛错，它的测试一条都不会被注册：${msg}`);
    }
  }
  const actual = measured.count;
  if (!actual) {
    // 「0 条」不是「没问题」：本仓库有 1900+ 条测试，数成 0 只可能是探针坏了
    // 或文件发现判据写窄了。静默 return 会让门变绿，而它其实什么都没核。
    fail(SCRIPTS_REL + '/', `实跑注册 0 条测试（扫到 ${measured.files || 0} 个文件）——`
      + '这在本仓库只可能是取数坏了，不是「没有测试」');
    return;
  }

  // 每份文档里「N 条回归测试」这一句的取数位置。只查**声明基线**的那一处，
  // 不查历史条目（CHANGELOG 与 research 里的旧数字是事实记录，不该被改）。
  //
  // 第三列 `required`：**声明了就必须对**，但没声明不报违规。
  // 这个区分来自 DF-046（「6 个常量把本仓库的形状当成了判据」）：别人项目里没有徽章，
  // 强制它「必须有一个」会在那个项目里造一条与本门目的无关的红。
  // 前四处仍是必需的 —— 它们是本仓规定的自证位置，缺了等于没人再核这个数。
  //
  // **这份清单是 TALLY_SITES（DF-090）的同一份数据。** 两处各写一份必然漂 ——
  // 而「同一件事有第二个答案」正是本仓库反复吃亏的形态。
  const sites = TALLY_SITES;

  // **平台无关性**：这道门必须在任何 runner 上数出同一个数，否则「文档写一个数」
  // 这件事就没法成立。2026-11-21 修 CI 红时的一度误判是「这个数平台相关」，理由是
  // 仓库里有 `{ skip: process.platform !== 'win32' }` 的用例 —— 但 `skip` 只决定
  // **跑不跑**，被 skip 的用例照样在 import 时注册一次，照样进总数（实测 3 条夹具
  // 里 2 条被 skip，探针仍数 3）。真正会引入平台差异的只有**条件注册**，本仓当前零处。
  //
  // 这里**不在绿的路上复数**：本门会在 `dispatch-coverage.test.mjs` 的副本里跑很多次，
  // 每次多一个子进程正是上一轮超时的来源。改成判红时才测 —— 红的那一刻多花约 1 秒，
  // 换来的是报错里直接写着「另一个平台也是这个数」，读的人不必翻代码去猜是不是平台差异。
  const otherPlatform = process.platform === 'win32' ? 'linux' : 'win32';
  let crossPlatform = null;
  const crossPlatformNote = () => {
    if (crossPlatform === null) {
      crossPlatform = countRegisteredTests(dir, { timeoutMs: 180000, platform: otherPlatform });
    }
    if (crossPlatform.error) return `；换成 ${otherPlatform} 平台复数失败（${crossPlatform.error}）`;
    return crossPlatform.count === actual
      ? `；换成 ${otherPlatform} 平台也是 ${crossPlatform.count} 条 → 与平台无关，是漏改文档`
      : `；换成 ${otherPlatform} 平台是 ${crossPlatform.count} 条 → **两平台不同，存在平台相关的条件注册**`;
  };

  for (const [file, re, required] of sites) {
    const p = join(ROOT, file);
    // 「必须**声明**测试数」是本产品自身的规矩（四个自证位置）。别人的项目里
    // 可以是「没有测试数声明」—— 那不是缺陷。所以 `required` 只在 productRepo 时生效；
    // 「写了就必须对」永远生效（写了假数字是任何项目的问题）。
    //
    // 文件存在性同理：`CLAUDE.md` / `docs/GUIDE.md` / `.github/workflows/validate.yml`
    // 是本产品自身的产物，别人的项目里不存在是正常的（DF-051）。
    if (!requireProduct(p, file)) continue;
    let text = '';
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    const m = text.match(re);
    if (!m) {
      if (required && PRODUCT_REPO) {
        fail(file, `找不到回归测试数声明（应形如「${actual} 条」）—— 删掉声明等于没人再核它`);
      }
      continue;
    }
    const claimed = Number(m[1]);
    if (claimed !== actual) {
      fail(file, `回归测试数写的是 ${claimed}，实跑注册 ${actual} 条（${measured.files} 个文件）`
        + `${crossPlatformNote()}。改成 ${actual}，或先确认新加的测试真的被注册了`);
    }
  }
}

// ── 检查 6.6：文档不许声称「测试全绿 / N 条 pass」—— 硬门核不了执行结果 ──

/** **这道门修的是「门在认证一句假话」这个缺陷本身**（DF-090）。
 *
 *  ## 现场
 *
 *  `docs/GUIDE.md:512` 曾写着「56 个测试文件，2080 项全绿（2078 条 pass、2 条按平台 skip）」，
 *  而 2026-11-24 实测 `node --test scripts/` 是 2071 pass / 7 fail / 2 skip。
 *  这句话是假的，而 `checkTestCount()` 给盖了绿章 —— 因为它**只核总条数**。
 *
 *  2080 这个总数是真的（注册数），所以「对账通过」也真的成立。缺陷在于：
 *  **注册数相等与「执行结果全绿」是两件事**，而文档把后者当成前者的推论写了。
 *  一句需要跑完全量测试才能验证的话，被一句只 import、不执行的检查认证了。
 *
 *  更糟的是**正则的形状在逼文档撒谎**：那处取数正则原本是 `(\d+)\s*项全绿`，
 *  于是「想通过硬门」这件事本身就要求文档里出现「全绿」二字。门不只在盖章，
 *  它是这句话的作者。（这就是 `TALLY_SITES` 里那一行被改口径的原因。）
 *
 *  ## 为什么不在硬门里真跑全量测试（评估过的三条路）
 *
 *  1. **硬门跑 `node --test scripts/`**：实测 258 秒（本机，2026-11-24）。
 *     本门会被 `dispatch-coverage.test.mjs` 在副本里跑很多次，每次多 4 分钟 ——
 *     那会让「改一行就跑一次门」变得不可行，而**门被跳过比门弱更坏**。
 *     而且那 7 条本就 flaky 的用例会让门随机变红，红警被驯化成噪音（DF-026）。
 *
 *  2. **硬门只跑一个「粗筛子集」**：仍要几十秒，且**粗筛通过不代表全量通过** ——
 *     它会造出一个新的、更隐蔽的假话：「粗筛全绿，所以全量全绿」。
 *
 *  3. **CI 负责跑，硬门核「文档与最近一次 CI 结果一致」**：需要把 CI 结果写回仓库
 *     （一个结果文件），而那份文件在本地永远是旧的 —— 于是「本地门绿」的意思变成
 *     「上次 CI 时是对的」。这是一条**我看不见它坏**的判据，比没有更坏。
 *
 *  ## 所以选第四条：让文档**不再声称**它核不了的事
 *
 *  这不是「降低标准」，而是**把断言的强度收回到证据能支撑的位置**：
 *  - 「2082 条已注册」是可核的（import 数一遍即可，本门就在做），保留；
 *  - 「2078 条 pass」核不了（要真跑 258 秒，且结果随环境漂），**删掉**；
 *  - 「全绿」是前一句的推论，随之删掉。
 *
 *  于是文档说的是「有多少条测试存在」，而不是「它们此刻是否通过」。
 *  后者只有 `node --test scripts/` 的当场输出能说；它正确的归属地是
 *  **跑它的那个人 / CI 的那次 job**，而不是一份会被反复引用的静态文档。
 *
 *  ## 判据
 *
 *  扫**自证位置所在的四份文档**（README / CLAUDE / GUIDE / CAPABILITIES），
 *  行内同时出现「测试语汇」与「执行结果断言」即违规。
 *
 *  **判据只管「数值化的执行结果」，不管「通过 / 失败」这两个词本身**：
 *  讨论「这条测试为什么失败」是正常内容，声称「2078 条 pass」才是断言。
 *  所以被禁的是 `全绿` / `全部通过` / `N 条 pass` / `N pass` / `N passed` /
 *  `pass: N` / `fail: N` 这些**带数或带绝对判断**的形态。
 *
 *  **跳过围栏代码块**：`README.md` 里那段「AI 说 BUILD SUCCESS — 1341 例全绿」
 *  是**被批判的假话示例**，它引用的正是本门要禁的形态。把它当违规会逼人删掉
 *  这段反例 —— 而那段反例是本产品最核心的一张图。围栏内的内容不是对仓库的断言。
 *
 *  **允许条件式与定义式**：`全绿才能提交`（提交门槛）`绿的标准`（定义）说的是
 *  规矩，不是当前状态。中文没有形态标记，这个区分认不全，所以只放行 `ALLOW`
 *  里那几种本仓确实在用的措辞；其余一律红 —— 宁可让人改写一句话，
 *  不可放过一句假的「已经绿了」。
 *
 *  **不扫 CHANGELOG 与 research/**：那两处是**历史记录**。「当时 1908 条全绿」
 *  在当时是真的，改它等于篡改历史。这也正是把范围限定在四份自证文档的原因 ——
 *  用「扫所有活文档」会连历史一起判红（实测 7 处误报，见 DF-090）。 */

/** 自证位置文档：本产品对外的「测试有多少、状态如何」的声明只该出现在这里。 */
const EXEC_CLAIM_DOCS = ['README.md', 'CLAUDE.md', 'docs/GUIDE.md', 'docs/CAPABILITIES.md'];

/** 条件式 / 定义式的标记。命中的行说的是「规矩」，不是「当前状态」。 */
const STATUS_CLAIM_ALLOW = [
  /才能提交/,      // 「两者都绿才能提交」—— 提交门槛
  /绿的标准/,      // 「绿的标准」—— 定义
  /不算绿|不算通过/,  // 「跑过不算绿」—— 否定式，不是断言
];

/** 执行结果断言（带数或绝对判断）的形态。 */
const EXEC_CLAIM_RE = new RegExp([
  '全绿',
  '全部通过',
  '\\d+\\s*条\\s*pass',       // 「2078 条 pass」
  '\\d+\\s*(?:passing|passed)',
  '(?<![A-Za-z])pass\\s*[:=]?\\s*\\d+',   // 「pass 2071」
  '(?<![A-Za-z])fail\\s*[:=]?\\s*\\d+',   // 「fail 7」
].join('|'));

/** 一行是不是在执行结果上做了断言。返回理由或 null。
 *
 *  **不导出**：本文件是 CLI（`CLI_SCRIPTS` 成员），一 import 就跑完全部门禁并 exit，
 *  没法单测。判据由 `regression-count.test.mjs` 与 `check-config.test.mjs` 那种
 *  「改坏副本 + 跑门真身」的方式验 —— 复制判据的测试只能证明自己那份对。 */
function execClaimOf(line) {
  if (!/(测试|回归|用例|\btests?\b)/i.test(line)) return null;
  const m = line.match(EXEC_CLAIM_RE);
  if (!m) return null;
  if (STATUS_CLAIM_ALLOW.some((re) => re.test(line))) return null;
  return `出现「${m[0]}」—— 这是对**执行结果**的断言，而硬门只 import 不执行，核不了它`;
}

function checkNoExecutionClaims() {
  for (const relPath of EXEC_CLAIM_DOCS) {
    const p = join(ROOT, relPath);
    // 四份都是本产品自身的产物。别人的项目里 CREDITS/README 长什么样不该由我们规定，
    // 所以用 requireProduct()（DF-051）；**存在就照查** —— 判据本身对任何项目成立。
    if (!requireProduct(p, relPath)) continue;
    let text = '';
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    let inFence = false;
    text.split('\n').forEach((line, i) => {
      // 围栏翻转：``` 或 ~~~ 开头的行（允许缩进）。围栏内的内容是**示例 / 引用**，
      // 不是对仓库的断言 —— 见头注释里 README 那段被批判的反例。
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
      if (inFence) return;
      const why = execClaimOf(line);
      if (why) {
        fail(relPath, `第 ${i + 1} 行 ${why}。改成只声明**条数**（那由 testCount 对账；`
          + 'pass/fail 交给每次真跑的输出），或写成条件式（「全绿才能提交」）如果那才是你的意思');
      }
    });
  }
}

// ── 检查 7：脚本必须能被 Node 解析 ────────────────────────────────────
/** 硬门不覆盖「脚本能不能跑」是一个真实漏洞：
 *  曾把 `const WINDOW = ;` 写进 scan-sessions.mjs，整个文件不可解析，
 *  但 check-structure 照样返回「全部通过」。语法检查必须进硬门。 */
function checkSyntax() {
  const dir = SCRIPTS_DIR;
  // 缺了脚本目录，语法检查无从谈起 —— 报「仓库坏了」，不是静默通过。
  if (!requirePath(dir, SCRIPTS_REL)) return;
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') || f.endsWith('.js'));
  if (!files.length) return;

  // `node --check` 一次可以接多个文件，一个进程查完（实测 6 个文件 1.5s，
  // 而逐个 spawn 要 9s）。
  // 曾试过在单进程里用 vm / new Function 复刻 --check，但 ESM 的 import/export
  // 需要先剥壳，剥壳本身引入了三次转义 bug —— 不如把这件事交还给 node 自己。
  const r = spawnSync(process.execPath, ['--check', ...files.map((f) => join(dir, f))], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (r.status !== 0) {
    const lines = (r.stderr || '').split('\n');
    const fileLine = lines.find((l) => l.includes('scripts')) || '';
    const errLine = lines.find((l) => l.includes('Error')) || '语法错误';
    fail(fileLine.trim() || SCRIPTS_REL + '/', `无法被 Node 解析：${errLine.trim().slice(0, 140)}`);
  }
}

// ── 检查 8：脚本导出的模块必须能被 import ────────────────────────────

/** 登记过的纯函数 → 调用参数（JSON 片段）。
 *  只调用这里列出的导出。没登记 = 不调用，由 checkUnregisteredExports 列成提示。
 *
 *  演进史：前缀白名单（覆盖 9/23）→ 黑名单（新函数默认被调）→ 本版参数白名单。
 *  黑名单的问题是 watch.mjs 的 startWatch 是常驻循环，被 {} 调中后门要等满 20s 超时，
 *  而且真把 state.json 写进了用户的 %LOCALAPPDATA%。每加一个副作用函数就要补一次
 *  黑名单，忘一次门就卡死。现在反过来：没登记就不调，登记这个动作本身就是一次审阅。 */
const PROBE_ARGS = {
  parseArgs: '[]', parseKeys: '"j"', parseKeysWithRest: '"j"',
  judgeState: '{}', noveltyOf: '[]', signatureOf: '["Read", {}]',
  // 2026-11-16 delta 接到 scan 行上：两个都是纯函数。
  // `deltaFieldOf` 空输入返回 null；`tailWindowOf` 空输入返回 { tail: [], truncated: false }。
  // 探针只喂最小可构造输入，正确性由 state-model.test.mjs 的五条负向用例守。
  deltaFieldOf: '[{}]', tailWindowOf: '[{}, 1]',
  normalizeBash: '"x"', heartbeatThreshold: '[]', isPersistentChange: '["Bash", {}]',
  displayWidth: '"x"', padDisplay: '["x", 1]', paint: '["x", "red", false]',
  badge: '["PRODUCING", false]', colorEnabled: '[{ isTTY: false }]',
  stripAnsi: '"x"', sanitize: '"x"', truncateToWidth: '["x", 1]',
  wrapToWidth: '["x", 1]', buildDraft: '[{}]', detailLines: '[{}, 80, false]',
  stripLongStrings: '"x"', collectSubagentFiles: '["/nonexistent"]',
  stateCounts: '[[]]', listRow: '[{}, 80, false, false]',
  columnHeaderLine: '[80]', listHeaderLine: '[1, 80, []]',
  usage: '[]', fmtDur: '[1]', fmtNovelty: '[0.5]', projectLabel: '["a-b"]',
  glyphOf: '[{}]', stateOf: '[{}]',
  reasonClass: '["novelty=0.1"]', dedupeKey: '["a", "STALLED", "novelty=0.1", "x"]',
  // DF-024：跨 state 的会话级收敛。纯函数，给两条同会话不同 state 的候选即可。
  convergeBySession: '[[{ sessionId: "s", state: "ASKED", reason: "x" }, { sessionId: "s", state: "WAITING", reason: "y" }]]',
  // measure-interventions.mjs（2026-11-11 人工介入基线）：全部纯函数，参数取最小可构造输入。
  // eachLine / analyzeTranscript / formatReport 读盘，用不存在的路径——空文件返回 0 行，
  // 不存在的路径在 analyzeTranscript 里会抛，外面 checkImportable 会吞掉（它只关心 ReferenceError）。
  userText: '[{}]', humanTurnText: '[{}]', isInterrupt: '[{}]', assistantStop: '[{}]',
  askedUser: '[{}]', isAskAnswer: '[{}]', classifyHumanMessage: '"继续"',
  avoidabilityOf: '[{ type: "nudge", text: "继续", afterStop: "end_turn" }]',
  percentile: '[[1, 2, 3], 0.5]',
  // compute-metrics.mjs（2026-11-23 走量指标）：判据层全是纯函数，探针取最小可构造输入。
  // 目的是让「导出但调用即炸」在结构门就暴露，而不是等到对 730 MB 语料跑完才发现。
  // `foldUsage` / `findVerdicts` / `parseAnchor` / `checkC2` / `verdictChains` /
  // `attemptsToPass` / `census` / `buildReport` / `formatReport` 全登记在这里。
  foldUsage: '[[]]', parseAnchor: '[""]', checkC2: '[{}]',
  checkAnchorResolvable: '[{}, { root: "/nonexistent-ow-probe", readFile: () => "" }]',
  findVerdicts: '[[]]', declaredOrdinal: '""', claimsPriorFail: '""', acSetOf: '""',
  verdictChains: '[[]]', attemptsToPass: '[[]]', census: '[[]]',
  countAcceptanceWork: '[[]]', pairAgentCalls: '[[], []]',
  buildReport: '[{}]', formatReport: '[{ metrics: [], dedupeKeys: { tokens: "m", calls: "t" }, minNForRate: 30 }]',
  eachLine: '["/nonexistent-ow-probe", (l) => l]',
  analyzeTranscript: '["/nonexistent-ow-probe"]',
  formatReport: '[{ days: 1, root: "/x", summary: { totals: { sessions: 0, humanTurns: 0, assistantStops: 0, interventions: 0, byType: {}, byAvoidability: {} }, distribution: { all: {}, active: {} }, rates: {}, sessionsWithIntervention: 0, perSession: [] } }]',
  defaultRoot: '[]',
  // project-commands.mjs / stop-verify-hook.mjs（2026-11-12 Stop hook 验证闸）。
  // 参数一律取最小可构造输入：不存在的路径 / 空对象 / 空串。目的是让「导出但调用即炸」
  // 在结构门就暴露 —— 这比等到 hook 在真实会话里崩掉再发现便宜得多。
  // 记账函数（appendLog / bumpBlockCount / …）在这里只会走到「读完发现没东西就返回」，
  // 不会写进用户的 %LOCALAPPDATA%：它们各自的 env 覆盖参数取不到真实路径。
  readCapped: '["/nonexistent-ow-probe", 64]',
  pickNpmScripts: '""', pickMaven: '""', pickGradle: '""', pickCargo: '""', pickGo: '""',
  pickPython: '[{}]', pickDotnet: '[false, false]',
  detectProjectCommands: '["/nonexistent-ow-probe"]', commandHint: '[{}]',
  modeOf: '[{}]', parseHookInput: '""', resolveAssistantText: '[{}, []]',
  decide: '[{ input: {}, records: [] }]', buildReason: '[{}]',
  logPathFor: '[{}]', statePathFor: '[{}]', readBlockCount: '["s", { env: {} }]',
  // 2026-11-16 用户叫停三层：全部纯读，无副作用。
  // 2026-11-21 `DF-041`：路径从「一个」变成「一族」（新旧状态目录都认），
  // 探针三种都登记 —— `pausePathsFor` 空 env 必须返回**非空**数组（返回空 = 闸关不掉），
  // 这一条由 `stop-verify-hook.test.mjs` 的 `DF-041` 用例守。
  pausePathFor: '[{}]', pausePathsFor: '[{}]', pausedPathOf: '[{}]',
  isPaused: '[{}]', lastBlockAt: '["s", { env: {} }]',
  PAUSE_FILE_NAME: '[]',
  userIntervenedSince: '["s", { records: [], env: {} }]',
  readTotalBlocks: '["s", { env: {} }]',
  // 2026-11-18 `DF-029`：Stop 的去重键构造。纯函数，空输入必须返回 null 而不是抛
  // （`claimKeyOf` 缺段即放弃去重，见 hook-dedupe.mjs 文件头 §失效方向）。
  stopTurnKeyOf: '[{}]',
  resetBlockCount: '["s", { env: {} }]',
  appendLog: '[{}, { OVERWATCH_STOP_VERIFY_LOG: _sandbox + "/x.jsonl" }]',
  bumpBlockCount: '["s", { env: { OVERWATCH_STOP_VERIFY_STATE: _sandbox + "/x.json" } }]',
  // `env: {}` 会**覆盖**探针进程里已设好的 `OVERWATCH_STATE_DIR`，于是 `runHook`
  // 真的往生产台账写一行 `unparsable-input`。不传 env 才走 process.env（已含沙箱路径）。
  runHook: '[{ input: { session_id: "probe", last_assistant_message: "" } }]',
  // readStdin 要一个 stream。给一个「已 EOF」的最小替身：setEncoding/on 是空操作，
  // readableEnded 为 true 让它在第一拍就 resolve 空串 —— 不会挂住结构门，也不需要
  // 在 ESM 探针脚本里 import('node:stream')。
  readStdin: '[{ setEncoding() {}, on() {}, readableEnded: true }, 64]',
  loadRecords: '["/nonexistent-ow-probe", {}]',
  loadSubagentRecords: '["/nonexistent-ow-probe"]',
  // 放行样本记录（2026-11-13）。样本层是**纯记账**，探针只要证明它不抛：
  // 空 records / 空文本 / 不可写路径都必须安全返回。sampleLogEnabled 读命令行，
  // 给空 argv 走默认「开」。
  SAMPLE_TEXT_LIMIT: '[]', samplePathFor: '[{}]', sampleLogEnabled: '[{}, []]',
  toolSummaryOf: '[[]]', rawFamilyHits: '""',
  buildSample: '[{}]', appendSample: '[{}, { OVERWATCH_STOP_VERIFY_SAMPLES: _sandbox + "/s.jsonl" }]',
  // analyze-hook-samples.mjs（2026-11-13）：放行样本的分布分析。全部只读，探针取最小输入。
  // 读盘的两个用不存在的路径 —— 返回空样本是它的正常路径，正好验「空文件不报错」。
  COLON_COMPLETION_RE: '[]', COMPLETION_ANY_RE: '[]',
  completionShapeOf: '""', clusterOf: '[{}]', suspectOf: '[{}]', strongSuspectOf: '[{}]',
  formatReport: '[{}, {}]', topSuspects: '[{}, 0]', defaultSamplesPath: '[{}]',
  parseSampleLines: '""', loadSamples: '["/nonexistent-ow-samples.jsonl"]',
  statLine: '["x", 0, ""]',
  emptyState: '[]', recordSent: '[{}, "sid", 0]',
  diffProbe: '[{}, {}]', foldProbe: '[{}, {}]',
  canNotify: '[{}, "sid", 0]', candidatesFromScan: '[[]]',
  escapeXml: '"x"', sanitizeTag: '"x"', recalibrateWeights: '[{}]',
  textOf: '[{}]', buildPayloadXml: '["t", "b", "g"]',
  lastPermissionMode: '[]', parseAskAnswers: '""', relevanceOf: '["a", ["b"]]',
  answerIsNegative: '""', findEarlierMatch: '["a", ["b"]]', classifyStop: '[{}]',
  findStopPoint: '[[]]', formatStats: '[{}]',
  // classify-stop.mjs / watch.mjs：未闭合等待型 tool_use 的锚点（2026-11-09 去重修复）。
  // 两者都是纯的：空记录返回 []、不存在的路径返回 null。
  openWaitingToolUseIds: '[[]]', waitingAnchor: '["/nonexistent", "sid", null, 0]',
  // asked.mjs 的现状对账（2026-11-02）。参数取最小可构造输入：
  // 空记录 / 缺失路径 / 空白时间戳，只要能跑通就算登记完成。
  // 这些函数都是纯的（readRecords/readHostSessions 读路径失败时返回 null/[]，不抛）。
  inspectRecords: '[[], {}]', readRecords: '["/nonexistent"]',
  lastCwd: '[[]]', readHostSessions: '["/nonexistent"]',
  continuedAfterQuestion: '[[], "2026-11-01T23:31:45.824Z"]',
  humanSpokeElsewhere: '[[], "2026-11-01T23:31:45.824Z"]',
  assessAsked: '[{}]',  unclassifiableMinIdleSec: '[]', tooRecentToNotify: '["UNCLASSIFIABLE", 60, 300]',
  // watch.mjs：BLOCKED 事件时刻解析（2026-11-02 假阳性修复）。
  // 参数取最小可构造输入：空串 / 不存在的路径 / 空对象都必须安全返回，不抛。
  requestIdTime: '[""]', lastTimelineStateTime: '["/nonexistent", "blocked"]',
  resolveJobEventTime: '[{}, "/nonexistent"]',
  // replay-observe.mjs：回放脚本的纯函数。参数取最小可构造输入，
  // 目的是让「导出但调用即炸」（ReferenceError）在结构门就暴露。
  nextTick: '[0, 0]', callsUpTo: '[[0, 1], 0]', gapsOf: '[[]]',
  capText: '"x"', compactRecord: '[{}]', isToolResultOnly: '[{}]',
  originKindOf: '[{}]', pct: '[1, 2]', buildSessionStops: '[[]]',
  sliceStops: '[[], []]', stateAt: '[{ ts: [], calls: [] }, 0]',
  observeStop: '[{ ts: [], calls: [] }, { t0: 0, after: [] }, 0]',
  corpusSummary: '[[]]', runDelayModel: '[[], {}]', runPollModel: '[[], {}]',
  rewatchSuppressed: '[[], {}]', renderStats: '[[]]',
  // stop-signals.mjs：判据全部是纯函数，参数取最小可构造输入。
  // 目的同上——让「导出但调用即炸」在结构门就暴露，而不是等到报告写完才发现。
  readSlice: '["/nonexistent", 0, 8]', parseRecords: '""',
  readTail: '["/nonexistent"]', readHead: '["/nonexistent"]',
  endsWithoutToolUse: '[[]]', errorOf: '[{}]', hasRecentError: '[[]]',
  toolFingerprint: '["Read", {}]', toolCallSequence: '[[]]', detectLoop: '[[]]',
  contextPressure: '[[]]', isHumanMessage: '[{}]', humanMessages: '[[]]',
  originalGoalFrom: '[[]]', questionAnswered: '[[]]', lastTextIsQuestion: '[[]]',
  classifySession: '[{}]', summarize: '[[]]', listTranscripts: '["/nonexistent"]',
  // state-dir.mjs（2026-11-17 改名迁移）：状态目录的唯一解析处。
  // `resolveStateDir` 只做路径判断 + 一次 `existsSync`，不写盘；空 env 必须安全返回。
  resolveStateDir: '[{}, {}]', stateRoot: '[{}]',
  // 两个目录名常量是字符串，不是函数 —— 见 INTENTIONALLY_PROBED_FREE。
  // stop-delta.mjs（2026-11-16 交还 delta）：判据层全是纯函数，探针取最小可构造输入。
  // 空记录 / 空文本 / 空数组都必须安全返回 —— 一个没有内容的会话不该让报告崩掉。
  computeDelta: '[{}]', summarizeDelta: '[[]]', deltaSlotsOf: '""',
  // 2026-11-16 异常认识与真人判据下沉（打破导入环）。全部纯函数。
  isHumanMessage: '[{}]', errorOf: '[{}]', lastErrorIndex: '[[]]',
  changeSetOf: '[[], {}]', lastHumanIndex: '[[]]',
  // verify-claims.mjs：断言 vs 证据配对。全部是纯函数，参数取最小可构造输入。
  // 目的是让「导出但调用即炸」在结构门暴露，而不是等到对 1.5 GB 语料跑完才发现。
  detectClaims: '""', findEvidence: '[[], "test-count"]', classifyEvidence: '[{}]',
  splitSentences: '""', stripQuoted: '""', isNegated: '""', isInterrogative: '""',
  // 原话还原（2026-11-14）：切句带位置 + 不切断行内代码的截断。两者都是纯函数。
  splitSentenceSpans: '""', truncateQuote: '["x", []]', quoteRangeOf: '["x", {}, []]',
  isSpeculative: '""', lastAssistantText: '[[]]', buildEvidenceIndex: '[[]]',
  claimedCount: '""', readBack: '["/nonexistent"]', readTailRecords: '["/nonexistent"]',
  listSessions: '["/nonexistent"]', enoughForClaim: '[[]]', enoughForClaims: '[[], []]',
  evidenceSufficient: '[{}, {}]', normalizeCommand: '""', isTestCommand: '""',
  isBuildCommand: '""', isMutatingCommand: '""', editKindOf: '""', resultText: '[{}]',
  parseLines: '""', subagentFiles: '[{}]', summarizeClaims: '[[]]',
  // 三个断言识别缺陷的修复（2026-11-13）：假设/间接疑问判据 + 中文族名。
  // 探针取最小输入 —— 空字符串、空匹配，要求「不抛且给出人话」。
  matchesOf: '[/x/, ""]', clauseAt: '["", 0]', isHypotheticalMatch: '["", null]',
  familyName: '""', activityName: '""',
  scanSession: '[{"path":"/nonexistent","project":"p","sessionId":"s","mtimeMs":0,"size":0}]',
  // verify-claims.mjs 的产品化层（2026-11-05）：CLI 参数、输出渲染、时间线。
  // 这一层的职责只是「把已经判好的结论说成人话」，**不许改判**；
  // 探针照样逐条实际调用，让「导出了但调用即炸」在结构门就暴露。
  timeOf: '[[], 0]', attemptTimes: '[[], []]', evidenceTimeline: '[{}, []]',
  fmtClock: '""', verdictIcon: '""', evidenceSentence: '[{}]', adviceFor: '[{}]',
  // 「该重跑什么」的溯源链（2026-11-13）。probe 用空对象：没有 claim / evidence 时
  // 必须走到「认不出」那一档而不是抛异常 —— 这正是它对坏输入的唯一要求。
  recoveryCommandFor: '[{}]', actualCommandFor: '[{}, "test-count"]', shortenCommand: '["", null]',
  // 「笼统完成声明」的验证判据（2026-11-13）。和 isTestCommand / isBuildCommand 同一层：
  // 给一条命令，答「它算不算做过一次检查」。冒烟输入取一条只读命令，必须返回 false。
  isVerificationCommand: '"ls -la"',
  // DF-058（2026-11-24）：空输出与只读否决。三个纯函数，各喂一个**最小且能区分**的输入。
  // `isSilentOutput` 喂空串 → true；`isSilentByDesign` 喂 `node --check` → true；
  // `isReadOnlyCommand` 喂 `grep foo check.mjs` → true。喂能命中的输入是有意的：
  // 探针要证明「函数被真的调起来且走得到 true 分支」，全喂 false 形态两个实现都能过。
  isSilentOutput: '""', isSilentByDesign: '"node --check a.mjs"', isReadOnlyCommand: '"grep -n foo check-x.mjs"',
  // compose-agent-prompt.mjs（2026-11-14 提示词分层拼装）：判定层全部纯函数，
  // 参数取最小可构造输入。读盘的几个用不存在的路径 / 空数组——「什么都没有」
  // 是它们的正常分支，正好顺带验一遍空而不炸。main 以外的副作用只有 appendFileSync，
  // 而它只在 CLI 的 compose 分支里被调用，结构门不会走到。
  parseFrontmatter: '""', roleTools: '""',
  // roles.mjs（2026-11-21，DF-044）：角色注册表。判定层全是纯函数，
  // 探针参数取最小可构造输入；读盘的三个（`discoverRoles` / `agentPrefixFrom` /
  // `defaultRoles`）用不存在的路径 —— 「目录不在」是它们的正常分支，
  // 正好顺带验一遍「空注册表不炸」。
  discoverRoles: '["/nonexistent-ow-agents"]',
  agentPrefixFrom: '["/nonexistent-ow-root"]',
  // 按根求值的注册表（2026-11-21）：`null` = 「只认框架」，不需要任何项目在盘上；
  // 这也是它最该验的分支（框架兜底），项目分支由 roles.test.mjs 端到端覆盖。
  rolesFor: '[null]', capabilitiesFor: '[null]', rolesDirFor: '"/nonexistent-ow-root"',
  sourceText: '[{ source: "framework", dir: "/nonexistent-ow-agents", roles: [] }]',
  // `AGENTS_DIR` 常量在 DF-062 里换成了按包根探测的两个函数：
  //   · `agentsDirCandidates` 是纯字符串拼接，喂一个不存在的包根即可；
  //   · `agentsDir` 在那种包根下必须返回**第一个候选**而不是 null / 抛（见它的注释）。
  agentsDirCandidates: '["/nonexistent-ow-pkg"]', agentsDir: '["/nonexistent-ow-pkg"]',
  // DF-062 整改（2026-11-21）：探测结果与路径遮罩。
  //   · `probeAgentsDir` 喂不存在的包根 → 必须返回 `dir` 非空 + `tried` 两条（不许 null）；
  //   · `displayPath` 是本仓「打印路径」的唯一出口，喂两段路径分别验三种回落：
  //     根下（`./x`）、根外（`<abs>/x`）、空串（`(无)`）。
  probeAgentsDir: '["/nonexistent-ow-pkg"]',
  displayPath: '["/nonexistent-ow-probe/.claude/agents", "/nonexistent-ow-root"]',
  idFromName: '"x"', truthyFlag: '""', readonlyOf: '[{}]', bashScopeOf: '[{}]',
  resolveRole: '[[]]', roleIndex: '[[]]', labelOf: '[[]]', nameOf: '[[]]',
  extractCommands: '""', classifyRequirement: '""', requiredTools: '[[]]',
  stopConditionProblem: '""',
  // 契约 §8.2 的失败通知判据（2026-11-23）：渲染函数喂合法类别、判据函数喂空串。
  // 两个都是纯函数，空输入必须安全返回（`failureNoticeProblem("")` 返回 null =
  // 「首轮没有通知」，那是正常分支）。
  failureNoticeText: '"acceptance"', failureNoticeProblem: '""',
  checkPromptSpec: '[{}]',
  fillDispatchTemplate: '["", {}]', composePrompt: '[{}]',
  deriveInjected: '[{ root: "/nonexistent-ow-probe" }]',
  normalizeForHash: '""', promptHash: '""', makePromptRow: '[{ run: "r", task: "t", hash: "h", bytes: 0 }]',
  firstUserText: '[[]]',
  verifyPrompts: '[{ rows: [], sessionPath: "/nonexistent-ow-probe" }]',
  renderSessionBlock: '[{}]', attemptTime: '[{}, 0]', renderMarkdown: '[[]]',
  exitCodeFor: '[{}]', renderSummary: '[{}]', renderDetail: '[{}, { claim: {} }]',
  parseArgs: '[[]]', resolveSession: '["/nonexistent", "abc"]', flattenResults: '[[]]',
  // project-root.mjs（2026-11-21，「两个根」拆分）：判定层全部纯函数。
  // 探针参数一律**喂空 env + 不可达 cwd**，于是它们走到第 5 级 ——
  // 「找不到就返回 null」是它们的正常分支，正好顺带验一遍不抛、不回落脚本位置。
  // `frameworkRoot` 只读 `import.meta.url`，零参数调用即可。
  // `levelText` 喂一个越界层级，验它「如实说未知」而不是编一个来源。
  frameworkRoot: '[]',
  resolveProjectRoot: '[{ env: {}, cwd: "/nonexistent-ow-probe" }]',
  projectRoot: '[{ quiet: true, env: {}, cwd: "/nonexistent-ow-probe" }]',
  rootFromArgv: '[[]]', searchUp: '["/nonexistent-ow-probe"]',
  levelText: '[99]', formatTried: '[[{ level: 1, at: "/x", ok: false, why: "未给" }]]',
  readPathsConfig: '["/nonexistent-ow-probe"]',
  runsDirInfo: '["/nonexistent-ow-probe", { config: null, env: {} }]',
  runsDirFor: '["/nonexistent-ow-probe", { config: null, env: {} }]',
  // stop-verify-hook.mjs 的 `ledgerRoot` 是 `resolveStateDir` 的别名（同一份判据，不是第二个）。
  // 空 env 必须安全返回一个**非空**路径 —— 返回空串会让 join 塌成相对路径。
  ledgerRoot: '[{}]',
  // measure-execution-phase.mjs（2026-11-14 执行期中断测量）：全部纯函数。
  // 参数一律取最小可构造输入（空对象 / 空串 / 空数组），让「导出但调用即炸」
  // 在结构门暴露。analyzeFile 用不存在的路径——它会抛，由 checkImportable 吞掉
  // （它只关心 ReferenceError）。run / formatReport 的完整正确性由
  // measure-execution-phase.test.mjs 的小目录用例覆盖。
  normToolName: '""', isWriteCall: '["Bash", { command: "ls" }]', isReadCall: '["Bash", { command: "ls" }]',
  optionLabels: '[[]]', questionsOf: '[{}]', classifyAnswer: '[{ options: [] }, ""]',
  createAccumulator: '[]', absorbRecord: '[{}, {}]',
  finalizeSession: '[{}, { path: "/x", bytes: 0, mtimeMs: 0 }]',
  groupSessions: '[[]]', groupStats: '[[]]', oneShotRate: '[[]]',
  ranks: '[[]]', spearman: '[[], []]', cliffsDelta: '[[], []]',
  spearmanPartial: '[[], [], []]', matchedPairs: '[[], []]',
  mulberry32: '[1]', permutationTest: '[[], []]',
  fnv1a: '[1, "x"]', recordSignature: '[{}]', analyzeFile: '["/nonexistent-ow-probe"]',
  // measure-intervention-cost.mjs（2026-11-14 中断代价测量）：全部纯函数。
  // 参数一律取最小可构造输入（空串 / 空数组 / 空对象），让「导出但调用即炸」
  // 在结构门暴露。readSessionDetail 用不存在的路径——它会抛，由 checkImportable
  // 吞掉（它只关心 ReferenceError）。run / formatReport 的完整正确性由
  // measure-intervention-cost.test.mjs 的小目录用例覆盖。
  normPath: '"x"', isReworkDemand: '""', undoEvents: '[[]]',
  commonPrefixLen: '[[], []]', dedupeResumeForks: '[[]]',
  readSessionDetail: '["/nonexistent-ow-probe"]', sessionCost: '[{ writes: [], humans: [], asks: [], seq: [], path: "/x", bytes: 0 }]',
  undoAroundInterruptions: '[{ writes: [], humans: [] }]', density: '[[], "x"]',
  groupRow: '[[]]', stratified: '[[]]',
  // measure-ask-vs-tell.mjs（2026-11-14 主指标重定义）：全部纯函数，参数取最小可构造输入。
  // readAskTimeline / cwdOf 读盘，用不存在的路径——readAskTimeline 会抛，由
  // checkImportable 吞掉（它只关心 ReferenceError）；cwdOf 自己 catch 后返回空串。
  // run / formatReport 要全量扫 2.1 GB，登记在 INTENTIONALLY_PROBED_FREE。
  isAskCall: '"AskUserQuestion"', classifyExecHuman: '"继续"', isCostly: '"继续"',
  readAskTimeline: '["/nonexistent-ow-probe"]',
  sessionRow: '[{ writes: [], humans: [], asks: [], seq: [], path: "/x", bytes: 0 }, { execTools: 0 }]',
  countOf: '[[], ["correction"]]', perSessionDensity: '[[]]', cleanRate: '[[]]',
  densityDiffTest: '[[], []]', cleanDiffTest: '[[], []]',
  matchedOnWork: '[[], []]', stratifyByWork: '[[]]',
  // tui-theme.mjs 的宽度算法（2026-11-05 宽度表修复）：Unicode 官方数据 + grapheme 聚类。
  // 参数取最小可构造输入，让「导出了但调用即炸」在结构门就暴露。
  codePointWidth: '"a"', truncateDisplay: '["x", 5]', hasColor: '"red"',
  segmenterAvailable: '[]', unknownColors: '[]', resetUnknownColors: '[]',
  setColorWarn: '[null]',
  // scan-sessions.mjs 的三源合并（2026-11-05）：--days 判据改为 transcript 内部时间。
  lastActivityOf: '[[]]', jobStateToState: '"blocked"', jobToRow: '[{}, 0]',
  mergeJobRows: '[[], [], 0]', windowLabel: '[3]',
  // 跨层去重的两个纯函数：空参数必须安全返回，不抛。
  scanCrossLayerFingerprint: '[{}]', hostFieldsOf: '[null]',
  // gen-width-table.mjs：从 scripts/data 下的 Unicode 原始数据生成宽度表。
  // 纯函数，参数取空输入即可跑通（readData 读的是仓库内已提交的数据文件）。
  parseUcdRanges: '""', parseEastAsianWidth: '""', parseEmojiPresentation: '""',
  mergeRanges: '[[]]', countCovered: '[[]]', renderModule: '[{}]',
  tableStats: '[{}]', readData: '[]',
  // tui-layout.mjs（2026-11-10 TUI 重做）：布局数学。参数取最小可构造输入，
  // 目的是让「导出了但调用即炸」在结构门就暴露 —— 这正是这次重构的主要收益之一。
  fmtSpan: '[1]', fmtAgeMs: '[1]', fmtScanAge: '[1]',
  truncateWithDisclosure: '["abc", 10]', alignRight: '["a", 3]',
  layoutRow: '[[], 10]', joinWithin: '[["a"], 10]',
  windowOf: '[{ count: 0, cursor: 0, area: 1 }]',
  resolveLayout: '[{ cols: 80, rows: 24 }]', layoutStages: '[]',
  binaryOf: '[{}]', partitionRows: '[{}]', verdictParts: '[{}]',
  // tui-layout.mjs（2026-11-11 需动作老化）：阈值两侧的纯函数。
  // 参数取最小可构造输入：空对象 / null 时钟都必须安全返回，不抛。
  ageLimitOf: '[{}]', ageSecOf: '[{}, null]', staleOf: '[{}]',
  stoppedSummary: '[[]]', sectionTitle: '["x", 0]',
  checklistRows: '[{}]', footerParts: '[{}]', actionCell: '[{}]', nearText: '[{}]',
  titleOf: '[{}]', shortPath: '""', runningColumns: '[80, {}]',
  runningRowOf: '[{}, { cols: 80 }]', actionRowOf: '[{}, { cols: 80 }]',
  sectionHeaderLine: '["x", 0, 80, ""]', checklistLine: '[{}, { cols: 80 }]',
  verdictLine: '[[], 80, ""]',
  // tui-layout.mjs（2026-11-11 检查表去表头）：句子 / 收尾句 / 零值压行。
  checklistSentence: '[{}]', checklistSummaryLine: '[4]',
  checklistLines: '[[], { cols: 80 }]', isQuietRow: '[{}]',
  footerLine: '[[], 80]', composeListScreen: '[{ cols: 80, rows: 24 }]',
  // tui-layout.mjs（2026-11-15 分节窗口）：三个新导出。
  //
  // `composeListFrame` 的探针参数**必须带 action/running**：空三段时走不到分节循环，
  // 于是「函数体里引用了未声明的变量」这类缺陷会被判成通过 —— 2026-11-15 的
  // `windows is not defined` 正是这样漏过去的（35 条测试红，结构门却是绿的）。
  // 探针要有牙，就得让它走到有分支的那条路上。
  sectionWindow: '[{ count: 3, area: 2 }]',
  sectionHiddenLine: '[{ label: "x", before: 1, after: 2, total: 5, cols: 80 }]',
  composeListFrame: '[{ cols: 80, rows: 24, action: [{}], running: [{}] }]',
  // tui-meta.mjs（2026-11-10）：有界读取与缓存。file 不存在时必须安全返回，不抛。
  projectsRoot: '[{}]', transcriptPathFor: '[{}, "/nonexistent"]',
  metaFromRecords: '[[]]', readTailRecords: '["/nonexistent"]',
  createMetaCache: '[{}]', lastSpeakerOf: '[[]]', pendingQuestionOf: '[[], {}]',
  askedVerdictOf: '[{}, {}]',
  // oversight-tui.mjs（2026-11-10）：三段视图与证据档位。
  viewOf: '[{}, null]', actionViewOf: '[{}]', buildSections: '[{}]',
  askedCountOf: '[{}]', waitingCountOf: '[{}]', claimsTally: '[[]]',
  scanAgeText: '[0, 0]',
  // tui-theme.mjs 的二值状态（2026-11-10）。
  binaryMark: '["running", false]', binaryColor: '["running"]',
  // claim-ledger.mjs（2026-11-13）：产出对账。判定层全部纯函数，参数取最小可构造输入。
  // 读盘的三个（readLedger / probeDisk / sha256File）一律给不存在的路径 —— 返回「没有」
  // 正是它们的正常空分支。appendRows 传空数组，它在建目录之前就返回 0，
  // 不会往仓库里写任何东西。
  makeNonce: '[]', findNonce: '["", []]',
  observedWrites: '[[]]', compareClaim: '[{}, {}]', foldRows: '[[]]',
  // Bash 写入识别（2026-11-13）：三个都是纯函数。探针给「一条判得出的命令 + 一个字面量 cwd」，
  // 目的是让「导出了但调用即炸」在结构门就暴露；判得对不对由 claim-ledger.test.mjs 守着。
  // 不用空字符串当探针：那会走「立即返回空数组」的分支，等于什么都没调。
  bashWrites: '["echo x > out.txt", "/repo"]',
  bashWriteScan: '["echo x > out.txt", "/repo"]',
  observedWriteScan: '[[], { cwd: "/repo" }]',
  reconcile: '[{ rows: [] }]', readLedger: '["/nonexistent-ow-ledger.jsonl"]',
  appendRows: '["/nonexistent-ow-dir/claims.jsonl", []]',
  ledgerPath: '["/x", "r"]', pathKey: '["a", "/x"]', resolvePath: '["a", "/x"]',
  // validate-run.mjs 的 outputs 判据（2026-11-13）。checkOutputs 用一份合法图调用，
  // 另外两个用合法输入调用——非法分支由 validate-run.test.mjs 覆盖（这里只保证
  // 「导出的函数真的能被调起来」）。合法/非法两条路径都覆盖，才不会出现
  // 「把校验改成恒真，结构门却照样绿」。
  checkOutputs: '[{ shape: "artifact", outputs: ["docs/a.md"] }]',
  outputPathError: '"docs/a.md"', outputPathKey: '"docs/a.md"',
  // 复杂度声明解析：三种输入覆盖三条分支（complex / simple / 未声明）。
  // 「两个都给」的冲突分支由 `--complex --simple` 的 CLI 用例覆盖 —— 探针只求
  // 「导出的函数真能被调起来」，不求在这里覆盖全部分支。
  complexityOpts: '[["--complex"]]',
  makeExpect: '[{ run: "r", task: "T", paths: ["a"] }]',
  makeClaim: '[{ run: "r", task: "T", path: "a" }]',
  makeObserve: '[{ run: "r", task: "T", path: "a" }]',
  makeConsume: '[{ run: "r", task: "T" }]',
  probeDisk: '["/nonexistent-ow-probe"]', sha256File: '["/nonexistent-ow-probe"]',
  subagentTranscriptsOf: '["/nonexistent-ow-probe"]',
  collectSubagentTranscripts: '["/nonexistent-ow-probe"]',
  readHeadText: '["/nonexistent-ow-probe", 8]', nonceOwners: '[[]]',
  // pre-write-gate.mjs（2026-11-14 写前闸）。判定层是纯函数，参数一律取最小可构造输入：
  // 空对象 / 空串 / 不存在的路径。带副作用的三个（writeMarker / appendLog /
  // bumpDenials）的 env 与路径都指向临时区 —— 探针不会写进任何真实项目。
  // 目的是让「导出了但调用即炸」在结构门暴露，而不是等到 hook 在真实会话里崩掉。
  //
  // 与 stop-verify-hook.mjs **重名**的六个导出（decide / runHook / parseHookInput /
  // readStdin / logPathFor / appendLog）不在这里重复登记：`PROBE_ARGS` 是一张扁平表，
  // 按名字命中所有模块，所以上面那份停在那里的探针参数同样会把本文件的同名导出调一次。
  // 本文件的签名对那几个探针都兼容（空对象 → passthrough，不写盘）。
  configOf: '[{}]', defaultConfig: '[]', markerPathFor: '["/nonexistent-ow-probe"]',
  denialPathFor: '["/nonexistent-ow-probe"]', pathKeyOf: '""',
  isGateOwnedPath: '["/nonexistent-ow-probe/.claude/.ow-read-done", "/nonexistent-ow-probe"]',
  powershellWriteScan: '"Get-Content a.txt"',
  writeIntentOf: '["Read", {}, "/nonexistent-ow-probe"]',
  readTranscriptReads: '["/nonexistent-ow-probe"]',
  // 2026-11-14 从 readTranscriptReads 抽出的纯解析层，重放器与闸门共用：
  // 提取纯函数让「同构」从声称变成保证，见 probe-parser-divergence.mjs。
  readPathsOfToolUse: '["Read", { file_path: "/nonexistent-ow-probe" }]',
  readPathsInTranscriptText: '""',
  readMarker: '["/nonexistent-ow-probe"]',
  writeMarker: '["/nonexistent-ow-probe/.claude/.ow-read-done", { sessionId: "probe" }]',
  markerValidity: '[{ marker: { exists: false }, secret: null }, { session_id: "probe" }]',
  // 2026-11-14 改动二：auto 标记的 HMAC 签名。密钥路径指向不存在的目录 —— 那是
  // 「还没有密钥」的正常分支，正好把 readGateSecret 返回 null 那条路也验一遍。
  markerSigOf: '[{ version: 1, session_id: "probe", at: "x", reads: 3 }, "k"]',
  verifyMarkerSig: '[{ version: 1, session_id: "probe", at: "x", reads: 3 }, null]',
  secretPathFor: '["/nonexistent-ow-probe"]',
  readGateSecret: '["/nonexistent-ow-probe/.claude/.ow-gate-secret"]',
  reasonFor: '[{ cwd: "/x", markerPath: "/x/m", gateCommand: "g", minReads: 3, halt: false }]',
  bumpDenials: '[_sandbox + "/pwg.json", "probe", { readOnly: true }]',
  cli: '[["status", "--cwd", "/nonexistent-ow-probe"], {}]',
  // 2026-11-19 `ask.minQuestionsBeforeWrite`（第一次写之前先问够 N 个问题）：
  // 判定层是纯函数，探针取最小可构造输入。`readTranscriptActivity` 给不存在的路径
  // —— 那是「读不到」的正常分支（`unreadable:true`），正好把 fail-open 那条也验一遍。
  // `minQuestionsBeforeWriteOf` 给一个不存在的配置文件：回落 0 是它的正常路径，
  // 而且**不能**让它去读仓库根的 `overwatch.config.json`（那是真配置）。
  readTranscriptActivity: '["/nonexistent-ow-probe"]',
  minQuestionsBeforeWriteOf: '[{}, { configFile: "/nonexistent-ow-probe.json" }]',
  reasonForQuestions: '[{ cwd: "/x", need: 3, have: 1, halt: false }]',
  MAX_MIN_QUESTIONS: '[]',
  // 2026-11-19（`DF-038` 修复）：口径的唯一实现 + 回扫上限常量。
  // `isAskToolName` 是**纯函数**，探针给三种名字（认的、不认的、空串），
  // 把两个分支都走一遍 —— 只给一个已认的值等于没验「不认」这一支。
  isAskToolName: '["AskUserQuestion"]',
  DEFAULT_MAX_SCAN_BYTES: '[]',

  // published-paths.mjs（`DF-039`）：判据是纯函数，探针取最小可构造输入。
  // 给一个**不含任何路径**的短串：「没有命中」是它们的正常分支，正好顺带验一遍；
  // 正确性（能不能抓到 / 会不会误放行）由 published-paths.test.mjs 逐条钉。
  normalizePathHit: '"x"',
  pathKeyOf: '"x"',
  isPlaceholderPath: '["D:\\\\x"]',
  findAbsolutePaths: '"no paths here"',
  publishedPathViolations: '"line one\\nline two"',
  // 2026-11-21 第二轮：已知本机标识符判据。探针给一个**不含任何中文**的串 ——
  // 「没有命中」是它的正常分支；命中路径由 published-paths.test.mjs 用假名字钉。
  knownIdentifierKeyOf: '"probe"',
  findKnownIdentifiers: '"no identifiers here"',

  // link-check.mjs（`DF-040`：文档相对链接的唯一判据）。
  // 纯函数给最小可构造输入：一段不含任何链接的文本必须安全返回空结果。
  // 读盘的三个（markdownFiles / publishableFiles / scanLinks）**不能进探针**：
  // 它们会 spawn git、并遍历整仓 170 份 .md —— 那正是「把跑一遍放进硬门」的灾难
  // （同 checkDocCommands 上方的理由）。它们的正确性由 link-check.test.mjs
  // 的临时目录端到端用例覆盖，`scanLinks` 也在那里用小目录真的跑一遍。
  stripCode: '"```\\nx\\n```"', slugifyAnchor: '"🚀 30 秒上手"',
  anchorsOf: '"# x"', isExternalLink: '"https://x"', linkOccurrences: '"no links"',
  describeBroken: '[{ file: "a.md", link: "b.md", line: 1, kind: "MISSING" }]',
  checkFileLinks: '[{ root: "/nonexistent-ow-probe", file: "a.md", text: "no links" }]',

  // observe-reality-check.mjs（2026-11-14 写前闸的真实语料重放）：
  // 判定函数全是纯的，探针取最小可构造输入。读盘的几个用不存在的路径 ——
  // 那正是「什么都没有」的正常路径，顺带把空分支也验一遍。
  // `defaultRoot` / `listTranscripts` / `fnv1a` / `recordSignature` / `distOf` 这些
  // 名字在别的模块已有同形探针（探针按名字命中**所有**模块），不重复登记。
  // 全量扫描（buildReport / main）要读 2GB 语料，登记在 INTENTIONALLY_PROBED_FREE。
  isSandbox: '[{}]', eachLineOffset: '["/nonexistent-ow-probe", () => {}]',
  verbsOf: '""',
  gateReadsOf: '["Read", {}]', broadReadsOf: '["Read", {}]',
  gateReadPathsInText: '""', tailGateReads: '["/nonexistent-ow-probe", 0]',
  structuralKind: '[{}]',
  verdict: '[{ firstWrite: { name: "Write", input: {} }, cwd: "/x" }]',
  GATE_READ_VERBS: '[]', STRUCT_VERBS: '[]', CONTENT_VERBS: '[]', STRUCT_TOOLS: '[]',

  // measure-gate-ceiling.mjs（2026-11-14 写前闸改宽上限）：判定层纯函数全部可调，
  // 探针取最小可构造输入；读盘的几个用不存在的路径（那是「什么都没有」的正常分支）。
  // 与 observe-reality-check.mjs 重名的导出（isSandbox / eachLineOffset / gateReadsOf
  // / tailGateReads / gateReadPathsInText / defaultRoot / listTranscripts / dedupeForks
  // / analyzeOne / agentToolIdsBefore / subagentReadsByToolId / looseSubagentReads
  // / isContinuation / CONTINUATION_RE / ATTRIBUTION_CLASSES / attribute）不重复登记 ——
  // PROBE_ARGS 按名字命中所有模块，上面那份探针会同样调用它们。
  gateReadsFixedOf: '["Bash", { command: "head -n 20 a.mjs" }]',
  // delivery-verdict.mjs（2026-11-22，证据分层与交付裁决）：判定层**全是纯函数**，
  // 逐个进 PROBE_ARGS 实际调用。参数取最小可构造输入 —— 空对象 / 空串 / 空数组，
  // 它们都必须安全返回、不抛。正确性由 delivery-verdict.test.mjs 的 39 条逐支钉
  // （含「验收 PASS 但红队 BLOCK → BLOCKED」这条两件事都成立的主用例）。
  // 五个枚举是数据，不是函数。
  deliverVerdict: '[{}]',
  parseAcceptorVerdict: '""',
  classifyEvidence: '[{}]',
  redteamItemProblems: '[{}]',
  coverageProblems: '""',
  isAnchored: '""',
  // 2026-11-23（DF-080）：收活读报告的两个入口。空串 / 空报告是它们的正常分支
  // —— 「读不到一张表」必须返回空清单 + problems，而不是抛。
  parseRedteamReport: '""',
  deviationRefsFrom: '""',

  // dispatch-quartet.mjs（2026-11-23，P0-1 第二项）：返回格式的解析判据，全是纯函数。
  // 参数取最小可构造输入 —— 空串 / 空数组 —— 都必须安全返回、不抛。
  // 正确性由 dispatch-quartet.test.mjs 的边界用例逐条钉（跳过围栏内伪标题 /
  // 三种坏输入各报各的错 / CRLF 与 LF 同结果）。`QUARTET_FIELDS` 是数据，登记在下面。
  outputFenceLines: '""',
  quartetGaps: '["", []]',

  // question-audit.mjs（2026-11-14 提问形态审计）：判定层全是纯函数，逐个实际调用。
  // 参数取最小可构造输入：空对象 / 空数组 / 空串 —— 都要安全返回，不抛。
  questionsOfAsk: '[{}]', normalizeText: '""', judgeReadFirst: '[{}]',
  judgeSession: '[{}, { ask: { mode: "always", maxQuestions: 5, requireReadFirst: true } }]',
  summarize: '[[], {}]', docTokenOverlap: '["x", []]',
  nearDuplicateQuestions: '[[]]', scanSession: '[[]]', validateConfig: '[{}]',
  loadConfig: '["/nonexistent-ow-probe.json"]',
  formatReport: '[{ summary: { sessions: 0, verdicts: {}, narrowVerdicts: {}, violCounts: {}, violations: 0 } }]',
  parseArgs: '[[]]',
  readWindowText: '["/nonexistent-ow-probe", 0]',
  windowReadPaths: '["/nonexistent-ow-probe", 0]',
  subagentPathSet: '[{ path: "/nonexistent-ow-probe/x.jsonl" }, []]',
  looseSubagentPathSet: '[{ path: "/nonexistent-ow-probe/x.jsonl" }]',
  upstreamOf: '[{}, []]',
  toolCallCount: '["/nonexistent-ow-probe"]',
  evidenceOf: '[{ path: "/nonexistent-ow-probe/x.jsonl", firstWrite: null }, [], { denied: false }]',
  variantSets: '[{ gateWin: new Set(), fixWin: new Set(), struct: new Set(), subStrict: new Set(), subLoose: new Set(), up: { set: new Set(), unique: false } }]',
  contentReads: '[{ gateWin: new Set(), fixWin: new Set(), subStrict: new Set(), subLoose: new Set(), up: { set: new Set() } }]',
  alignWithBaseline: '[{ threshold: 3, real: { withWrite: 0, zeroRead: 0, variants: {}, attribution: {} }, sandbox: { withWrite: 0, variants: {} }, rows: { real: [] } }]',
  parserEquivalence: '[[]]',
  byToolCalls: '[{ threshold: 3, rows: { real: [] } }]',
  byDate: '[{ threshold: 3, rows: { real: [] } }]',
  dropLargestProject: '[{ threshold: 3, rows: { real: [] } }]',
  BASE_THRESHOLD: '[]',

  // build-payload.mjs（2026-11-14 plugin 载荷生成）：判定层全部纯函数，探针取最小输入。
  // 读盘的两个（summarizeSources / planPayload）给不存在的路径 —— 「什么都没有」是它们的
  // 正常分支，正好把空分支也验一遍。checkPayload 同理（载荷目录不存在时直接返回一条原因）。
  // 会**写盘**的 buildPayload 不在这里：它拿到不存在的 root 会先攒 problems 并在写之前返回，
  // 但这个「先返回」是一条将来可能被改掉的实现细节，不该被结构门当作安全保证 —— 所以
  // 它和 main 一起登记在 INTENTIONALLY_PROBED_FREE，正确性由 build-payload.test.mjs 覆盖。
  // 函数名刻意不叫 parseArgs：探针表是按名字命中所有模块的扁平表，重名会被另一份参数调用。
  defaultOutDir: '["/nonexistent-ow-probe"]',
  summarizeSources: '["/nonexistent-ow-probe"]',
  payloadDigest: '[[{"source": ".claude/agents/a.md", "sha256": "bb"}]]',
  pluginManifest: '"a"', pluginManifestBytes: '"a"',
  planPayload: '[{"root": "/nonexistent-ow-probe"}]',
  checkPayload: '[{"root": "/nonexistent-ow-probe"}]',
  parseArgv: '[]',
  // DF-060 引入的两个纯函数（脚本引用闭包）。同样喂不存在的路径 ——
  // 「什么都没有」是它们的正常分支：没有 markdown → 引用集为空；闭包从空集展开也是空。
  referencedScriptRoots: '[]',
  scriptClosure: '["/nonexistent-ow-probe", []]',
  // check-config.mjs（2026-11-21，6 个常量参数化）：判定层全是纯函数，参数取最小
  // 可构造输入。三处读盘的一律用不存在的路径 —— 「什么都没有」是它们的正常分支，
  // 正好顺带把空分支验一遍，且绝不碰真实项目。
  //   · `loadChecks('/nonexistent-ow-probe')` → 没有配置文件 → 回落 DEFAULTS；
  //   · `livingDocsGap` 喂空 scope → 立刻返回空差集，不遍历磁盘；
  //   · `listMarkdown` / `scopedMarkdown` 用不存在的根 → 空数组。
  // `normRel` / `validateChecks` / `DEFAULTS` / `CHECK_NAMES` 见参数表与数据登记。
  loadChecks: '["/nonexistent-ow-probe", { env: {} }]',
  validateChecks: '[{}]', normRel: '"a/b"',
  // `domainOf` 喂一个**未登记**的名字：这正是元检查要判的形态（必须返回 null
  // 而不是抛，也不是静默当成 universal —— 后者会让 DF-051 以「新加的一条规矩」复发）。
  domainOf: '"this-name-is-not-a-check"',
  livingDocsGap: '["/nonexistent-ow-probe", { include: [], exclude: [] }, []]',
  listMarkdown: '["/nonexistent-ow-probe"]',
  scopedMarkdown: '["/nonexistent-ow-probe", { include: [], exclude: [] }]',
};

/** 需要临时目录的导出，参数由探针注入 `_sandbox` */
const SANDBOX_ARGS = {
  loadState: '[_sandbox]', saveState: '[_sandbox, {}]',
  probeJobs: '[_sandbox]', probeMtime: '[_sandbox]',
  createLogger: '[_sandbox]', defaultStateDir: '{}', defaultNotifyDir: '{}',
  readLogHealth: '[_sandbox]', logHealthPath: '["/nonexistent"]',
  // DF-028：`procWitnessPath` 是纯路径拼接；`readProcWitness` 读不存在的目录 → null。
  // `judgeProcess(null)` 走 unverified 分支，**不发任何探针**（DF-092 之后探针是
  // 「连一次命名管道」，那条冷路径不该由结构门承担，更不该对真实 PID 发信号）。
  // `writeProcWitness` 写到沙箱（`_sandbox` 由探针注入），不碰真实数据目录。
  procWitnessPath: '["/nonexistent"]', readProcWitness: '["/nonexistent"]',
  processStartedAt: '[]', judgeProcess: '[null]',
  // DF-092 的两个新判据（纯函数，喂最小可构造输入即可）：
  //   · `pidIsAlive(0)` → false（pid 必须为正整数；Windows 上 kill(0,0) 会成功，
  //     那是「当前进程组」不是「进程存在」，所以判据里先挡掉它）；
  //   · `probeFailureReason('timeout', {pid: 1})` → 一句说「超时」的理由（DF-091）。
  pidIsAlive: '[0]', probeFailureReason: '["timeout", { pid: 1 }]',
  // proc-liveness.mjs（DF-092）的三个纯函数。`livenessEndpoint` 走 POSIX 分支要
  // 一个 stateDir —— 传 `/nonexistent` 正好把「纯拼接、不碰盘」验一遍。
  // `parseBeatFrame` 喂一段不是帧的文本：返回 null 是它的正常分支（读不懂 = 判不了）。
  // `makeNonce` 不注入随机源就真取一次随机字节 —— 它不碰盘、不需要沙箱。
  makeNonce: '[]',
  livenessEndpoint: '[{ nonce: "probe", stateDir: "/nonexistent-ow-probe", platform: "linux" }]',
  parseBeatFrame: '["not a frame"]',
  // 错误码 → probe 状态。喂一个未知码必须落回 `error`（不是 `not-found`）——
  // 「不认识的原因」不能当成「进程没了」，那会把判不了说成死了。
  stateOfErrorCode: '["EZOMBIE"]',
  writeProcWitness: '[_sandbox]',
  createObservationLog: '[_sandbox]', observationStats: '[_sandbox]',
  classifyCandidate: '[{}]', readTranscriptTail: '["/nonexistent"]',
  // pre-write-gate.mjs 的签名密钥生成（2026-11-14）。它会 real 写盘，所以只能进
  // SANDBOX_ARGS —— 探针把它指到结构门自己的临时目录，不碰任何真实项目。
  ensureGateSecret: '[_join(_sandbox, "pwg-secret")]',

  // hook-dedupe.mjs（2026-11-18，`DF-029` 的幂等层）。三条都会写盘，所以一律进
  // SANDBOX_ARGS 并且路径由 `_sandbox` 拼 —— 它们**本身就是「写一个文件」这件事**，
  // 不给路径就没法验「调用即炸」。
  //   · claimOnce     认领一次事件（O_EXCL 创建）；空键走「放弃去重」分支，不写盘
  //   · recordSkipped 追加一行跳过记录
  //   · sweepIfCrowded 清理过期认领文件；目录不存在时安全返回
  // 另外两个纯路径拼接（claimPathFor / claimDirFor）与一个纯解析（claimKeyOf）也在这里，
  // 它们只需要最小可构造输入。
  claimDirFor: '[_sandbox, "probe"]',
  claimPathFor: '[_sandbox, "probe", "k"]',
  claimKeyOf: '["probe", ["a"]]',
  dedupeRoot: '[{}]',
  claimOnce: '[{ hookId: "probe", key: "k", env: { OVERWATCH_HOOK_DEDUPE_DIR: _sandbox } }]',
  recordSkipped: '[{ hookId: "probe", key: "k", env: { OVERWATCH_HOOK_DEDUPE_DIR: _sandbox } }]',
  sweepIfCrowded: '[_sandbox]',

  // 两个文件发现判据是**纯函数**（只读目录、不执行任何东西），给一个不存在的目录
  // 必须安全返回 false / []。它们必须真被调用一次：`isNodeTestFile` 写窄了的
  // 表现是「数不到」，而数不到不报错（实测：新模块叫 `test-count.mjs` 被 node
  // 当成测试真执行了一次，只认 `*.test.mjs` 的判据对此一无所知）。
  isNodeTestFile: '["x.mjs"]', nodeTestFiles: '["/nonexistent-ow-probe"]',

  // make-social-preview.mjs 的渲染层（2026-11-18）：把顶层副作用收进 main() 之后
  // 才可被调用。`renderPng` 只产字节、不写盘 —— 正好用来验「点了就炸」。
  renderPng: '[]',
};

/** 同名但**签名不同**的导出：不参加强制调用。
 *
 *  `PROBE_ARGS` 是一张**扁平**表，按名字命中所有模块。而 `stop-verify-hook.mjs` 与
 *  `pre-write-gate.mjs` 里这几个名字一样、签名不一样：
 *
 *    stop-verify-hook : runHook({ input, env })          —— 一个对象
 *    pre-write-gate   : runHook(input, { env, nowMs })   —— 两个位置参数
 *
 *  拿 stop hook 那份参数去打 `pre-write-gate.runHook`，它读不到 `cwd`，
 *  回落到 `process.cwd()`（= 仓库根），然后**真的往生产台账写一行**。
 *  2026-11-18 实测：这正是每次跑结构门 `pre-write-gate/<日期>.jsonl` +2 行的原因，
 *  而且只在 `DF-031` 把 66 条静默跳过的探针打开之后才暴露 ——
 *  这个泄漏一直被「根本没验证」掩盖着。
 *
 *  宁可少覆盖几个，也不要用 A 的形状去调 B：那样得到的「通过」是假的。 */
const CROSS_MODULE_SKIP = Object.freeze([
  'runHook', 'decide', 'logPathFor', 'appendLog', 'readStdin', 'parseHookInput',
]);

/** `node --check` 只查语法，查不到「调用了一个不存在的函数」。
 *  曾把 wrapToWidth 的循环变量改了一半，语法全绿、结构门全绿，
 *  但按 ? 打开帮助就抛 ReferenceError。
 *
 *  性能：曾对每个文件起一个 node 进程（8 文件 × 1.5s ≈ 12s）。现在一个进程跑完，
 *  单文件失败不影响其他文件。 */
function checkImportable() {
  const dir = SCRIPTS_DIR;
  // 同上：import 探针的价值全在覆盖面上，目录缺了必须是红。
  if (!requirePath(dir, SCRIPTS_REL)) return;

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && !CLI_SCRIPTS.has(f));
  if (!files.length) return;

  const base = 'file:///' + dir.split('\\').join('/');
  const script = [
    'import { mkdtempSync, rmSync } from "node:fs";',
    'import { join as _join } from "node:path";',
    'import { tmpdir } from "node:os";',
    'const _sandbox = mkdtempSync(_join(tmpdir(), "ow-gate-"));',
    'process.env.OVERWATCH_STATE_DIR = _sandbox;',
    'process.on("exit", () => { try { rmSync(_sandbox, { recursive: true, force: true }); } catch {} });',
    `const PROBE_ARGS = ${JSON.stringify(PROBE_ARGS)};`,
    `const SANDBOX_ARGS = ${JSON.stringify(SANDBOX_ARGS)};`,
    `const FILES = ${JSON.stringify(files)};`,
    `const DIR = ${JSON.stringify(base)};`,
    `const CROSS_MODULE_SKIP = ${JSON.stringify([...CROSS_MODULE_SKIP])};`,
    'const SKIP = new Set(CROSS_MODULE_SKIP);',
    'const failures = [];',
    '// 并行 import：串行时每个 import 只花几十毫秒，但整轮仍受进程启动主导；',
    '// 并行后 6 个模块合计 78ms，而不是 6 × 1.5s。',
    'const MODS = await Promise.all(FILES.map((f) =>',
    '  import(DIR + "/" + f).then((m) => [f, m]).catch((e) => [f, null, e.message])));',
    'for (const [f, m, err] of MODS) {',
    '  if (!m) { failures.push([f, "import: " + err]); continue; }',
    '  let m2 = m;',
    '  for (const [k, v] of Object.entries(m2)) {',
    '    if (typeof v !== "function") continue;',
    '    if (SKIP.has(k)) continue;',
    '    const src = PROBE_ARGS[k] !== undefined ? PROBE_ARGS[k] : SANDBOX_ARGS[k];',
    '    if (src === undefined) continue;',
    '    let a;',
    // 探针参数按 **JS 表达式**求值，而不是要求写成 JSON。
    //
    // 2026-11-18 实测（`DF-031`）：这里原本是 `JSON.parse("[" + src + "]")`，
    // 而 `PROBE_ARGS` 里大量条目的值是 JS 对象字面量（`{ env: {} }`、
    // `[{ isTTY: false }]`、`[{ summary: {...} }]`）—— 它们不是合法 JSON，
    // 于是 **458 条里 66 条被静默跳过**。被跳过的恰好是 `appendLog` / `runHook` /
    // `decide` / `resetBlockCount` / `bumpBlockCount` / `reconcile` 这些
    // **有副作用、最该被验**的导出：结构门对它们一个字都没验证，
    // 却在别处声称「导出了但调用即炸会在这里暴露」。
    //
    // 静默跳过在这里格外危险：它的表现和「这条探针通过了」完全一样。
    //
    // 为什么是求值而不是把这 66 条改写成 JSON：
    //   · 逐条改是**改数据**，下一个加探针的人还会写成 JS 字面量，同一个坑再踩一次；
    //   · 求值是**改机制**，`{ env: {} }` 这种写法从此就是对的。
    //   安全前提：探针在子进程里跑，且 `OVERWATCH_STATE_DIR` 已在本脚本开头指到临时目录
    //   （见 `process.env.OVERWATCH_STATE_DIR = _sandbox`），两个 hook 都认它 ——
    //   所以「真的调用一次 `runHook`」不会写进生产台账。
    // 注意必须是**直接** eval（`eval(...)`）而不是间接的 `(0, eval)(...)`：
    // 间接求值在 ESM 里跑在全局作用域，看不到本模块的 `_sandbox` / `_join`，
    // 而 `SANDBOX_ARGS` 里正是用这两个变量拼路径。实测：写成 `(0, eval)` 时
    // `ensureGateSecret` / `createLogger` 等 5 条会报 `_join is not defined` ——
    // 报错比静默跳过好，但它们本来能过。
    '    try { a = eval("[" + src + "]"); } catch (e) {',
    '      failures.push([f, k + ": 探针参数求值失败（" + e.message + "）：" + src.slice(0, 80)]);',
    '      continue;',
    '    }',
    // 把每个对象实参上的 `env` 强制指进沙箱。
    //
    // 探针表里有 `{ env: {} }`、`{ env: { OVERWATCH_STOP_VERIFY_LOG: ... } }` 这类写法，
    // 它们**覆盖**了进程级 `OVERWATCH_STATE_DIR`，于是「调一次 appendLog 看它炸不炸」
    // 会真的往生产台账写一行。实测：`pre-write-gate.appendLog` 与 `stop-verify-hook.appendLog`
    // 同名，探针按名字命中两个模块，前者不认 `OVERWATCH_STOP_VERIFY_LOG`，
    // 于是回落到仓库默认路径 —— 每跑一次结构门就多一行 `sid=undefined`。
    //
    // 修在**机制层**而不是逐条改数据：新增探针不需要记得这件事，
    // 想往沙箱外写也写不出去。
    '    for (const arg of a) {',
    '      if (!arg || typeof arg !== "object" || Array.isArray(arg)) continue;',
    '      if (!("env" in arg)) continue;',
    '      arg.env = { ...(arg.env || {}), OVERWATCH_STATE_DIR: _sandbox };',
    '    }',
    '    try {',
    '      const r = v(...a);',
    '      if (r && typeof r.then === "function") await r.catch(() => {});',
    '    } catch (e) {',
    '      if (e instanceof ReferenceError) { failures.push([f, k + ": " + e.message]); break; }',
    '    }',
    '  }',
    '}',
    'if (failures.length) { console.error(JSON.stringify(failures)); process.exit(1); }',
  ].join('\n');

  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 45000,
  });
  if (r.status !== 0) {
    let detail = '';
    try {
      const list = JSON.parse(String(r.stderr || '').trim().split('\n').pop());
      detail = list.map(([f, msg]) => `${f} → ${msg}`).join('; ');
    } catch {
      detail = (String(r.stderr || '').trim().split('\n').find((l) => l.trim()) || '未知错误');
    }
    fail(SCRIPTS_REL + '/', `import 或调用导出函数时失败：${detail.slice(0, 220)}`);
  }
}

// ── 检查 9：文档相对链接 ──────────────────────────────────────────────

/** 相对链接必须按其所在目录解析。曾用仓库根当基准，导致 `../adr/x.md`
 *  这类正确链接被误报为断链，于是检查器只好退化成建议门。
 *
 *  **判据本体搬到 `scripts/link-check.mjs`**（`DF-040`）。原先这里和
 *  `check-links.mjs` 是**两份实现、同一份手写文件清单**：
 *
 *      const files = ['README.md', 'CLAUDE.md'] ... walkMd(join(ROOT, 'docs'))
 *
 *  于是根级 `CONTRIBUTING.md` / `CONTRIBUTING-EN.md` / `SECURITY.md` / `SECURITY-EN.md`
 *  一份都不在范围内，两边都报「0 断链」。手写清单的失效方式是结构性的 ——
 *  与 `checkAbsolutePaths()` 判「会不会发出去」弃用手写清单是同一个理由。
 *
 *  现在两边共用一份判据、一份范围（问 git），并且判据有单测
 *  （`link-check.test.mjs`）。这里只负责把结果转成 `fail()`。 */
function checkLinks() {
  const { broken } = scanLinks({ root: ROOT });
  for (const b of broken) fail(b.file, `第 ${b.line} 行${KIND_TEXT[b.kind] || '链接有问题'}：${b.link}`);
}

/** 参数白名单的代价：新加的纯函数若忘了登记，就不会被探到。
 *  这里把它变成可见的提示，而不是静默跳过——不阻塞（有些导出本来就是有副作用的），
 *  但每次都会列出来，提醒去登记或确认它不需要登记。 */
function checkUnregisteredExports() {
  const dir = SCRIPTS_DIR;
  if (!requirePath(dir, SCRIPTS_REL)) return;
  const REGISTERED = new Set([
    'parseArgs', 'parseKeys', 'parseKeysWithRest', 'judgeState', 'noveltyOf',
    // stop-signals.mjs（判据与汇总）
    'readSlice', 'parseRecords', 'readTail', 'readHead', 'endsWithoutToolUse',
    'errorOf', 'hasRecentError', 'toolFingerprint', 'toolCallSequence', 'detectLoop',
    'contextPressure', 'isHumanMessage', 'humanMessages', 'originalGoalFrom',
    'questionAnswered', 'lastTextIsQuestion', 'classifySession', 'summarize',
    // stop-delta.mjs（2026-11-16）：交还 delta 的正交轴。四个函数已进 PROBE_ARGS 实际调用；
    // 两个冻结表是数据，不是函数。
    'computeDelta', 'summarizeDelta', 'deltaSlotsOf', 'changeSetOf', 'lastHumanIndex',
    'resolveStateDir', 'stateRoot',
    // project-root.mjs（2026-11-21）的常量与两个环境变量名：不是函数，checkArgs 调不动。
    // 行为由 project-root.test.mjs 的 27 条用例守。
    'LEVELS', 'PROJECT_MARKERS', 'DEFAULT_RUNS_REL', 'ROOT_ENV', 'RUNS_DIR_ENV',
    'isHumanMessage', 'errorOf', 'lastErrorIndex',
    'DELTA_VERDICTS', 'SLOT_STATES',
    'signatureOf', 'normalizeBash', 'heartbeatThreshold', 'isPersistentChange', 'parseJsonl', 'SUBAGENT_READ_BYTES',
    'deltaFieldOf', 'tailWindowOf',
    'displayWidth', 'padDisplay', 'paint', 'badge', 'colorEnabled', 'stripAnsi',
    'sanitize', 'truncateToWidth', 'wrapToWidth', 'buildDraft', 'detailLines',
    'stripLongStrings', 'collectSubagentFiles', 'stateCounts', 'listRow',
    'columnHeaderLine', 'listHeaderLine', 'usage', 'fmtDur', 'fmtNovelty',
    'projectLabel', 'glyphOf', 'stateOf', 'reasonClass', 'dedupeKey', 'convergeBySession',
    'emptyState', 'loadState', 'saveState', 'recordSent', 'probeJobs', 'pruneNotified', 'NOTIFIED_TTL_HOURS',
    'probeMtime', 'diffProbe', 'foldProbe', 'canNotify', 'candidatesFromScan',
    'createLogger', 'defaultStateDir', 'escapeXml', 'sanitizeTag', 'textOf',
    'buildPayloadXml', 'defaultNotifyDir', 'lastPermissionMode',
    'parseAskAnswers', 'relevanceOf', 'answerIsNegative',
    'findEarlierMatch', 'classifyStop', 'notifyTitle',
    'findStopPoint', 'readTranscriptTail', 'classifyCandidate',
    'createObservationLog', 'observationStats', 'formatStats', 'readObservationRows', 'readObservationRows', 'NOTIFY_KINDS', 'OBS_MAX_BYTES',
    'unclassifiableMinIdleSec', 'tooRecentToNotify', 'UNCLASSIFIABLE_MIN_IDLE_SEC', 'IDLE_BUCKETS',
    'traceability', 'readJobStates', 'probeWaiting', 'readLiveSessionStates',
    'buildInbox', 'formatInbox', 'healthCheck', 'formatHealth', 'HEALTH_PERIODS',
  // watch.mjs 的日志健康旁挂文件（2026-11-12）。readLogHealth 已进 PROBE_ARGS
  // （用 `_sandbox` 真的调一次）；logHealthPath 是纯路径拼接，也进 PROBE_ARGS；
  // LOG_HEALTH_FILE 是数据（文件名常量），不是函数。
  'readLogHealth', 'logHealthPath', 'LOG_HEALTH_FILE',
  // watch.mjs 的进程见证（DF-028，2026-11-18）：「进程死了」与「进程卡住了」可区分。
  // `judgeProcess` 进 PROBE_ARGS 但不传见证 → 走 unverified 分支，**不发探针**
  // （否则每跑一次结构门要真连一次命名管道，且这条冷路径的代价不该由硬门承担）。
  // `PROC_TOLERANCE_MS` 与 `BEAT_TIMEOUT_MS` 是数字，不是函数 —— checkArgs 调不动它们。
  'procWitnessPath', 'writeProcWitness', 'readProcWitness', 'processStartedAt',
  'judgeProcess', 'PROC_TOLERANCE_MS',
  // DF-092 / DF-091（2026-11-24）：判活从 spawn 换成命名管道之后新增的三个导出。
  // `pidIsAlive` 与 `probeFailureReason` 已进 PROBE_ARGS 实际调用；
  // `BEAT_TIMEOUT_MS` 是数字（转发自 proc-liveness.mjs），判据是数据不是函数。
  'pidIsAlive', 'probeFailureReason', 'BEAT_TIMEOUT_MS',
  // proc-liveness.mjs（DF-092）：判活端点这一层。三个纯函数进 PROBE_ARGS：
  //   · `makeNonce` 产出 24 个十六进制字符（长度就是它的判据）；
  //   · `livenessEndpoint` 是纯路径拼接（Windows 前缀 / POSIX 文件路径）；
  //   · `parseBeatFrame` 喂一段不是帧的文本 → null（那是它的「读不懂」正常分支）。
  // 两个有副作用的不进强制调用（见 INTENTIONALLY_PROBED_FREE）：
  // `startLivenessServer` 会**真的占一个端点**，`probeLiveness` 会**真的连一次**。
  // 常量与安全表是数据。
  'makeNonce', 'livenessEndpoint', 'parseBeatFrame',
  'LIVENESS_PROTOCOL', 'PROBE_STATES', 'PROBE_OUTCOME', 'beatFrame',
    'statusToState', 'liveToRow', 'mergeLiveSessions', 'listRow', 'detailLines', 'pendingLines',
    'claimOwnership', 'readOwner', 'ownerPath', 'askedCandidates',
    'requestIdTime', 'lastTimelineStateTime', 'resolveJobEventTime', 'BLOCKED_MAX_AGE',
  // job-event-time.mjs（2026-11-10 抽出）：跨层去重的地基。
  // 三个函数已进 PROBE_ARGS 实际调用；常量是数据，不是函数。
  'TIMELINE_TAIL_BYTES',
  // scan-sessions.mjs（2026-11-10 跨层去重）：宿主字段摊平与 job 指纹的唯一实现。
  'scanCrossLayerFingerprint', 'hostFieldsOf',
    // asked.mjs
    'lastAssistantText', 'endsWithQuestion', 'classifyQuestion',
    'inspectTranscript', 'scanAll', 'formatResult', 'GREETING', 'DEFAULT_MIN_HOURS',
    'questionKey', 'sessionIdOf', 'loadHistory', 'saveHistory', 'mergeHistory',
    'historyStats', 'historyPath', 'formatHistory', 'BACKLOG_HOURS', 'MAX_QUESTION_HOURS',
    // asked.mjs 的现状对账（2026-11-02）。这些都会被 PROBE_ARGS 实际调用，
    // 所以「调用一个不存在的函数」在这道门就会暴露。
    'inspectRecords', 'readRecords', 'lastCwd', 'readHostSessions',
    'continuedAfterQuestion', 'humanSpokeElsewhere', 'assessAsked',
    'ASKED_FRESHNESS', 'ASKED_MAX_SILENCE_HOURS',
    // classify-stop.mjs / watch.mjs 的等待锚点（2026-11-09）。两个都已进 PROBE_ARGS 实际调用。
    'WAITING_TOOL_NAMES', 'openWaitingToolUseIds', 'waitingAnchor',
    // probe-relay.mjs
    'listSessions', 'readPeerToken', 'canConnect', 'buildFrame', 'sendFrame', 'interpretReply',
    // validate-run.mjs
    'validateGraph', 'validateFile', 'CAPABILITIES', 'SHAPES', 'REQUIRED_FOR_COMPLEX', 'MIN_SUBTREES',
    // validate-run.mjs 的复杂度声明解析（DF-042，2026-11-21）：CLI 的
    // `--complex` / `--simple` → `requireComplex`。**这就是缺陷 A 的修复点**——
    // 在它存在之前 CLI 从不传 opts，硬约束 2 的三条检查在命令行上永不执行。
    // 已进 PROBE_ARGS 实际调用（覆盖「两个都给」那条冲突分支）。
    'complexityOpts',
    // validate-run.mjs 的 outputs 判据（2026-11-13）：每个子树必须声明「磁盘上会多出什么」。
    // checkOutputs 走 PROBE_ARGS 真实调用一次（登记在下面）；另外两个是它内部的纯判据，
    // 由 validate-run.test.mjs 的合法/非法两组用例覆盖，这里按数据登记。
    'SHAPES_REQUIRING_OUTPUTS', 'checkOutputs', 'outputPathError', 'outputPathKey',
    // validate-run.mjs 的依赖图判据（2026-11-15）：环检测 + 前置失败开关。
    // `checkDependencyCycles` 有两条真调用（合法链 / 环），见 validate-run.test.mjs；
    // `ON_DEP_FAILED` 是枚举数据，按数据登记。
    'checkDependencyCycles', 'ON_DEP_FAILED',
    // install-watcher.mjs
    'launcherPath', 'templatePath', 'stateDirFor', 'startupDir', 'shortcutPath',
    'renderLauncher', 'needsRegenerate', 'createShortcut', 'autostartAdvice', 'witnessPath', 'writeWitness', 'readWitness', 'checkStateIntegrity', 'HOST_FACT_STATES',
    'recalibrateWeights', 'NOTIFY_STATES', '__internals', 'STATES', 'DAY', 'HOUR', 'MINUTE', 'App', 'KINDS',
    // replay-observe.mjs
    'nextTick', 'callsUpTo', 'gapsOf', 'capText', 'compactRecord', 'isToolResultOnly',
    'originKindOf', 'pct', 'buildSessionStops', 'sliceStops', 'stateAt', 'observeStop',
    'corpusSummary', 'runDelayModel', 'runPollModel', 'rewatchSuppressed', 'renderStats',
    'POLL_INTERVAL_MS', 'DEFAULT_MIN_IDLE_SWEEP', 'DEFAULT_DELAYS_SEC',
    // verify-claims.mjs：断言 vs 证据配对（2026-11-03）。纯函数逐个进了 PROBE_ARGS。
    'detectClaims', 'findEvidence', 'classifyEvidence', 'splitSentences', 'stripQuoted',
    // verify-claims.mjs 原话还原（2026-11-14）：都已进 PROBE_ARGS 实际调用。
    'splitSentenceSpans', 'truncateQuote', 'quoteRangeOf',
    'isNegated', 'isInterrogative', 'isSpeculative', 'lastAssistantText', 'buildEvidenceIndex',
    'claimedCount', 'readBack', 'readTailRecords', 'listSessions', 'enoughForClaim',
    'enoughForClaims', 'evidenceSufficient', 'normalizeCommand', 'isTestCommand',
    'isBuildCommand', 'isMutatingCommand', 'editKindOf', 'resultText', 'parseLines',
    'subagentFiles', 'summarizeClaims', 'scanSession',
    // verify-claims.mjs 的产品化层（2026-11-05）。函数已进 PROBE_ARGS 实际调用。
    'timeOf', 'attemptTimes', 'evidenceTimeline', 'fmtClock', 'verdictIcon',
    'evidenceSentence', 'adviceFor', 'renderSessionBlock', 'attemptTime',
    'recoveryCommandFor', 'actualCommandFor', 'shortenCommand',
    'renderMarkdown', 'exitCodeFor', 'renderSummary', 'renderDetail',
    'resolveSession', 'flattenResults',
    // verify-claims.mjs 的常量与正则。都是数据，不是函数；函数已逐条登记在 PROBE_ARGS 里。
    'CLAIM_TAIL_BYTES', 'DEFAULT_BACKTRACK_BYTES', 'BACKTRACK_STEPS', 'EVIDENCE_STATUS',
    'EDIT_TOOLS', 'SHELL_TOOLS', 'CLAIM_FAMILIES', 'NEGATION_RE', 'INTERROGATIVE_RE',
    'SPECULATIVE_RE', 'FENCED_CODE_RE', 'BLOCKQUOTE_LINE_RE', 'TEST_CMD_RE', 'BUILD_CMD_RE',
    'COMMIT_CMD_RE', 'PUSH_CMD_RE', 'CI_CMD_RE', 'SYNC_CHECK_CMD_RE', 'RUNTIME_CMD_RE',
    'FAIL_OUTPUT_RE', 'COMMIT_OK_RE', 'PUSH_OK_RE', 'PUSH_REJECT_RE', 'SKIP_TESTS_RE',
    'GIT_READONLY_RE', 'BASH_MUTATION_RE', 'CODE_EXTS', 'DOC_EXTS', 'NON_SOURCE_FILES',
    // 笼统完成声明族（2026-11-13）：一条正则 + 一条否决条件 + 一条验证命令判据。
    'COMPLETION_RE', 'COMPLETION_VETO_RE', 'VERIFY_CMD_RE',
    // 三个断言识别缺陷的修复（2026-11-13）：假设/间接疑问判据 + 中文族名。
    // 函数进 PROBE_ARGS 实际调用；正则与冻结表是数据。
    'matchesOf', 'clauseAt', 'isHypotheticalMatch', 'familyName', 'activityName',
    'HYPOTHETICAL_LEAD_RE', 'HYPOTHETICAL_MARK_RE', 'HYPOTHETICAL_BRIDGE_RE',
    'INVERSION_QUESTION_RE', 'FAMILY_NAMES', 'ACTIVITY_NAMES',
    // 三个断言识别缺陷的修复（2026-11-13）：假设/间接疑问判据 + 中文族名表。
    // 都是数据（正则 / 冻结表），函数已逐条登记在 PROBE_ARGS 里。
    'HYPOTHETICAL_LEAD_RE', 'HYPOTHETICAL_MARK_RE', 'HYPOTHETICAL_BRIDGE_RE',
    'INVERSION_QUESTION_RE', 'FAMILY_NAMES', 'ACTIVITY_NAMES',
    // verify-claims.mjs 产品化层的常量与帮助文本。
    'HELP_TEXT', 'ALERT_STATUS',
    // tui-theme.mjs 的宽度算法（2026-11-05）。宽度表来自 Unicode 官方数据，
    // 由 gen-width-table.mjs 生成；这些导出保证「表与算法」都有探针。
    'truncateDisplay', 'codePointWidth', 'hasColor', 'segmenterAvailable',
    'unknownColors', 'resetUnknownColors', 'setColorWarn',
    // scan-sessions.mjs 的三源合并（2026-11-05）：--days 改用 transcript 内部时间，
    // 并从 jobs/*/state.json 补入没有 transcript 的会话。
    'lastActivityOf', 'jobStateToState', 'jobToRow', 'mergeJobRows', 'windowLabel',
    // gen-width-table.mjs：从 scripts/data 下的 Unicode 原始数据生成宽度表。
    'parseUcdRanges', 'parseEastAsianWidth', 'parseEmojiPresentation',
    'mergeRanges', 'countCovered', 'renderModule', 'tableStats', 'readData',
    'DATA_DIR', 'OUT_PATH',
    // oversight-tui.mjs（2026-11-05）：光标身份、来源标签、空列表的诚实文案。
    'sessionKey', 'sourceLabel', 'emptyLines',
    // tui-layout.mjs（2026-11-10 TUI 重做）：列表页的布局数学，全部是纯函数。
    // 抽出它们的目的就是「可单测」，所以每一条都必须进 PROBE_ARGS 被真实调用一次。
    'TIERS', 'NEVER_DROP', 'fmtSpan', 'fmtAgeMs', 'fmtScanAge', 'truncateWithDisclosure',
    'alignRight', 'layoutRow', 'joinWithin', 'windowOf', 'resolveLayout', 'layoutStages',
    'ACTION_STATES', 'binaryOf', 'partitionRows', 'verdictParts', 'stoppedSummary',
    'sectionTitle', 'checklistRows', 'footerParts', 'actionCell', 'nearText', 'titleOf',
    'shortPath', 'runningColumns', 'runningRowOf', 'actionRowOf', 'sectionHeaderLine',
    'checklistLine', 'checklistSentence', 'checklistSummaryLine', 'checklistLines', 'isQuietRow',
    'verdictLine', 'footerLine', 'composeListScreen',
    // tui-layout.mjs（2026-11-15 分节窗口）：滚动时「需动作段不被切」的那一组。
    'sectionWindow', 'sectionHiddenLine', 'composeListFrame',
    // tui-meta.mjs（2026-11-10）：标题 / 末条 assistant 的有界读取与 mtime 缓存。
    'META_TAIL_BYTES', 'projectsRoot', 'transcriptPathFor', 'metaFromRecords',
    'readTailRecords', 'createMetaCache', 'lastSpeakerOf', 'pendingQuestionOf',
    // 2026-11-16：「问了没答」的判定与  同源（四道门），纯函数。
    'askedVerdictOf',
    // oversight-tui.mjs（2026-11-10 TUI 重做）：分段视图与证据档位。
    'viewOf', 'actionViewOf', 'buildSections', 'askedCountOf', 'waitingCountOf',
    'claimsTally', 'scanAgeText', 'defaultClaimsScan',
    // 2026-11-11：草稿可复制性说明（剪贴板里只能有能直接发出去的文字）。
    'buildDraft', 'draftHintOf',
    'ACTION_MAX_AGE_SEC', 'ageLimitOf', 'ageSecOf', 'staleOf',
    // width-table.mjs：由 gen-width-table.mjs 生成的纯数据表（不是函数，无需探针）。
    'EAW_WIDE', 'EMOJI_PRESENTATION',
    // tui-theme.mjs 的二值状态表（2026-11-10）：彩色下统一 `•`，无色下换形状。
    'BINARY', 'binaryMark', 'binaryColor',
    // measure-interventions.mjs（2026-11-11）：人工介入测量。判据全部是纯函数，
    // 参数取最小可构造输入；读盘的两个（eachLine / analyzeTranscript）用不存在的路径。
    'MAX_CLASSIFY_LEN', 'CORRECTION_MAX_LEN', 'INTERRUPT_RE', 'AVOIDABILITY',
    'userText', 'humanTurnText', 'isInterrupt', 'assistantStop', 'askedUser',
    'isAskAnswer', 'classifyHumanMessage', 'avoidabilityOf', 'percentile',
    'eachLine', 'analyzeTranscript', 'formatReport', 'defaultRoot',
    // project-commands.mjs（2026-11-12 Stop hook 验证闸）：项目类型探测。
    // 纯函数逐个进 PROBE_ARGS；detectProjectCommands 读的是「一个不存在的目录」，
    // 返回 unknown —— 这是它的正常路径，正好把「认不出」分支也验一遍。
    'MAX_READ_BYTES', 'readCapped', 'pickNpmScripts', 'pickMaven', 'pickGradle',
    'pickCargo', 'pickGo', 'pickPython', 'pickDotnet', 'detectProjectCommands', 'commandHint',
    // stop-verify-hook.mjs（2026-11-12）：Stop hook 验证闸。判定层（decide / buildReason /
    // resolveAssistantText / modeOf / parseHookInput）是纯的，参数取最小可构造输入；
    // 记账层（appendLog / bumpBlockCount / readBlockCount / resetBlockCount / logPathFor /
    // statePathFor）在有副作用前就返回，不会写进用户的 %LOCALAPPDATA%。
    'BLOCKING_STATUS', 'DEFAULT_BACKTRACK_MB', 'DEFAULT_BUDGET_MS', 'ESCALATE_AT',
    'MAX_BLOCKS', 'RESET_AFTER_MS', 'modeOf', 'parseHookInput', 'readStdin',
    'resolveAssistantText', 'decide', 'buildReason', 'logPathFor', 'appendLog',
    'statePathFor', 'bumpBlockCount', 'resetBlockCount', 'readBlockCount', 'readTotalBlocks', 'runHook',
    'pausePathFor', 'pausePathsFor', 'pausedPathOf', 'PAUSE_FILE_NAME',
    'isPaused', 'lastBlockAt', 'userIntervenedSince',
    // 2026-11-18 `DF-029`：Stop 的去重键构造（纯函数，输入进、字符串出）。
    'stopTurnKeyOf',
    'loadRecords', 'loadSubagentRecords', 'SUBAGENT_TAIL_BYTES',
    // stop-verify-hook.mjs 的放行样本记录（2026-11-13）。纯记账层：写入失败一律
    // 吞掉，所以探针只需要证明「给了最小输入也不抛」。分析命令的导出同批登记。
    'SAMPLE_TEXT_LIMIT', 'samplePathFor', 'sampleLogEnabled', 'toolSummaryOf',
    'rawFamilyHits', 'buildSample', 'appendSample',
    // analyze-hook-samples.mjs（2026-11-13）：放行样本的分布分析。全程只读，
    // 空输入必须能跑 —— 一个空样本文件不该让分析命令报错。
    'COLON_COMPLETION_RE', 'COMPLETION_ANY_RE', 'completionShapeOf', 'clusterOf',
    'suspectOf', 'strongSuspectOf', 'summarize', 'formatReport', 'topSuspects',
    'defaultSamplesPath', 'parseSampleLines', 'loadSamples', 'statLine',
    // verify-claims.mjs 的「做过检查没有」判据（2026-11-13），已进 PROBE_ARGS。
    'isVerificationCommand',
    // verify-claims.mjs（2026-11-24，DF-058）：空输出判据 + 只读否决。
    // 四个都是纯函数 / 正则常量，参数取最小可构造输入（空串 / 空对象），
    // 正确性由 `verify-claims.test.mjs` 的 10 条 DF-058 用例守。
    'isSilentOutput', 'isSilentByDesign', 'isReadOnlyCommand',
    'EMPTY_OUTPUT_RE', 'SILENT_OK_RE',
    // claim-ledger.mjs（2026-11-13）：产出对账。判定层全是纯函数，参数取最小可构造输入；
    // 读盘的三个（readLedger / probeDisk / sha256File）用不存在的路径——那正是它们
    // 的「什么都没有」正常路径，正好把空分支也验一遍。appendRows 传空 rows，
    // 它在建目录之前就返回 0，不会写进仓库。
    'makeNonce', 'findNonce', 'observedWrites', 'compareClaim', 'foldRows',
    'bashWrites', 'bashWriteScan', 'observedWriteScan',
    'reconcile', 'readLedger', 'appendRows', 'ledgerPath', 'pathKey', 'resolvePath',
    'makeExpect', 'makeClaim', 'makeObserve', 'makeConsume',
    'probeDisk', 'sha256File', 'subagentTranscriptsOf', 'collectSubagentTranscripts',
    'readHeadText', 'nonceOwners',
    // 常量与枚举：都是数据，不是函数。
    'LEDGER_VERSION', 'LEDGER_FILE', 'HASH_MAX_BYTES', 'SUBAGENT_HEAD_BYTES',
    'OBSERVE_TAIL_BYTES', 'WRITE_TOOLS', 'ITEM_STATUS', 'TASK_VERDICT', 'FAILING_VERDICTS',
    // compose-agent-prompt.mjs（2026-11-14）：提示词分层拼装。
    // 判定层全是纯函数，逐个进 PROBE_ARGS 实际调用；读盘的四个用不存在的路径
    // （那正是它们「什么都没有」的正常路径，顺带把空分支验一遍）。
    'promptHash', 'readPromptLedger', 'subagentFiles', 'readHeadRecords',
    // 数据：四层声明、义务三分类、必填元素清单 —— 不是函数，无需探针。
    'LAYERS', 'OBLIGATION_KINDS', 'REQUIRED_ELEMENTS', 'REQUIRED_PLACEHOLDERS',
    'FORBIDDEN_CONTEXT',
    // probe-evidence-sources.mjs（2026-11-14 扩宽判据的取证探针）：全部导出都是
    // 「读语料并汇总」，没有一个是能拿空参数安全调用的纯判据 —— sectionA/B/C/D
    // 都要遍历 400+ 份 transcript（其中 sectionD 还要读子 agent 正文，全量 6 GB）。
    // 让它进 checkImportable 会让结构门本身跑上几分钟，所以整体登记为免探针；
    // 正确性由报告 §7 的复算命令与 `--section X` 的单项运行保证。
    'SANDBOX_RE', 'SANDBOX_SLUG_RE', 'GATE_READ_VERBS', 'STRUCT_VERBS', 'CONTINUATION_RE',
    'defaultRoot', 'isSandbox', 'cwdOf', 'listMainTranscripts', 'subagentDirOf',
    'readTail', 'eachRecord', 'toolUsesOf', 'gateReadPaths', 'gateReadsFromToolUse',
    'pathKey', 'idNamespace', 'agentToolUseIds', 'agentIdsFromResults',
    'sectionA', 'sectionB', 'sectionC', 'sectionD', 'format', 'main',
    // check-config.mjs（2026-11-21）：五个函数已进 PROBE_ARGS 实际调用；
    // 两个字符串常量与两张冻结表是**数据**，checkArgs 调不动它们。
    // `DEFAULTS` 的正确性由「本仓自检」直接对账（`.untildone/checks.json` == DEFAULTS），
    // 那比喂个空参数强得多 —— 它验的是内容，不是「调用不炸」。
    'CONFIG_REL', 'CONFIG_ENV', 'CHECK_NAMES', 'DEFAULTS',
  ]);
  const INTENTIONALLY_PROBED_FREE = new Set([
    'main', 'printPlain', 'copyToClipboard', 'startWatch', 'runTick',
    'runScan', 'dispatchCandidates', 'sendNotification', 'isNotificationAvailable',
    'NOTIFY_STATES', '__internals',
    // proc-liveness.mjs（DF-092）：这两个**有真副作用**，不能进结构门的强制调用。
    //   · `startLivenessServer` 会真的 listen 一个端点名 —— 结构门跑一次就会在
    //     系统里留下一个管道，且它的名字来自 nonce，无法预先指定；
    //   · `probeLiveness` 会真的 connect（甚至在端点不存在时花掉一段连接超时）。
    // 两者的正确性由 `watch.test.mjs` 的 DF-028 / DF-092 组用**真端点**覆盖
    // （起监听、探、关掉、再探），那比「调用不炸」强得多。
    'startLivenessServer', 'probeLiveness',
    // watch.mjs 的 asked 子进程扫描（DF-097）。它**会真的 spawn 一个 node 去读 1.3 GB
    // 语料**（实测 70 秒）—— 结构门绝不能调它一次，那会把整道门变成 70 秒以上。
    // 正确性由 `watch.test.mjs` 的 DF-097 组用**小目录**覆盖（喂一个不存在的根，
    // 子进程约 2.5 秒返回空结果，那正是它的「什么都没有」正常分支）。
    'runAskedScanInChild',
    // 这两个要读真实 transcript 目录（1GB），不能塞进结构门；由 CLI 自测覆盖。
    'parseTranscript', 'listTranscripts', 'loadCorpus',
    // measure-interventions.mjs：run 会全量扫 1.7GB transcript（实测 24s），不能进结构门；
    // 它的正确性由 measure-interventions.test.mjs 里的小目录用例覆盖。
    'run', 'COUNT_PER_STOP', 'INTERRUPT_MARKER',
    // 2026-11-16：正则与字符串常量，不是可调用函数 —— checkArgs 调不动它们。
    // 由 `stop-delta.test.mjs` 的「打断标记两种变体」「宿主合成前缀」两条用例覆盖。
    'SYNTHETIC_PREFIX', 'CONTINUATION', 'INTERRUPT_RE',
    // defaultClaimsScan 会 spawn verify-claims 子进程（实测 7.2s），不能塞进结构门；
    // 它有独立的 `--plain` 端到端覆盖（见 tui-redesign.test.mjs）。
    'defaultClaimsScan',
    // stop-signals.mjs 的常量与汇总扫描：scanAll 要读 186 个 transcript（1.4GB），
    // 同样不能塞进结构门；判据本身已逐条登记在 PROBE_ARGS 里。
    'TAIL_BYTES', 'HEAD_BYTES', 'LOOP_WINDOW', 'LOOP_REPEAT', 'CONTEXT_NEAR_FULL_RATIO',
    'scanAll', 'KINDS',
    // 2026-11-17 改名迁移：两个常量是**字符串映射**，不是可调用函数 —— checkArgs 调不动。
    // `resolveStateDir` 的行为由 watch/asked/notify/install-watcher 四份测试共同覆盖。
    'STATE_DIR_NAME', 'LEGACY_DIR_NAME',
    // measure-execution-phase.mjs：run 会全量扫 1.8GB transcript（实测 37s），
    // 不能进结构门；它的正确性由 measure-execution-phase.test.mjs 的小目录端到端用例覆盖。
    // 三个常量是数据（工具白名单 / 文本截断长度 / 空闲切分参数），不是函数。
    'run', 'summarize', 'formatReport', 'WRITE_TOOLS', 'READ_TOOLS', 'SHELL_TOOLS',
    'TEXT_CAP', 'IDLE_GAP_MS',
    // measure-ask-vs-tell.mjs：run 要全量扫 2.1 GB transcript（实测 72s），
    // 不能进结构门；正确性由 measure-ask-vs-tell.test.mjs 的小目录用例覆盖。
    // 这里只登记与上面重名的两个（summarize / formatReport 已在本表里）。
    // 它的其它常量已进注册表，不重复列。
    // build-payload.mjs：buildPayload 会 rmSync + writeFileSync（真写盘），不能进结构门；
    // 正确性由 build-payload.test.mjs 的生成 / 可复现 / 先清空 / 源坏一件不写 四条用例覆盖。
    'buildPayload',
    // check-config.mjs（2026-11-21）：五个函数已进 PROBE_ARGS 实际调用；
    // 两个字符串常量与两张冻结表是数据。`DEFAULTS` 的内容正确性由
    // `check-config.test.mjs` 的「本仓自检」直接对账，那比「调用不炸」强得多。
    'loadChecks', 'validateChecks', 'normRel', 'livingDocsGap', 'listMarkdown',
    'scopedMarkdown', 'CONFIG_REL', 'CONFIG_ENV', 'CHECK_NAMES', 'DEFAULTS',
    // 2026-11-23（DF-051）：检查的**适用域**表与查询。
    //   · `CHECK_DOMAINS` 是数据（名字 → 域），不是函数；
    //   · `domainOf` 是纯函数，已进 PROBE_ARGS 实际调用（喂一个未登记的名字，
    //     必须返回 null 而不是抛 —— 那正是元检查要判的形态）。
    'CHECK_DOMAINS', 'domainOf',
  ]);
  // measure-execution-phase.mjs 的纯函数：全部已进 PROBE_ARGS 实际调用，
  // 这里显式登记，免得被上面的「未登记导出」提示刷屏。
  const EXEC_PHASE_FNS = [
    'normToolName', 'isWriteCall', 'isReadCall', 'optionLabels', 'questionsOf',
    'classifyAnswer', 'createAccumulator', 'absorbRecord', 'finalizeSession',
    'groupSessions', 'groupStats', 'oneShotRate', 'ranks', 'spearman', 'cliffsDelta',
    'mulberry32', 'permutationTest', 'fnv1a', 'recordSignature', 'analyzeFile',
    'spearmanPartial', 'matchedPairs',
  ];
  for (const k of EXEC_PHASE_FNS) REGISTERED.add(k);

  // measure-intervention-cost.mjs（2026-11-14 中断代价测量）：全部纯函数。
  // 探针参数取最小可构造输入（空串 / 空数组 / 空对象），要求「不抛」。
  // run / summarize / formatReport 要全量扫 1.9 GB，登记在 INTENTIONALLY_PROBED_FREE。
  const COST_FNS = [
    'normPath', 'isReworkDemand', 'undoEvents', 'commonPrefixLen', 'dedupeResumeForks',
    'readSessionDetail', 'sessionCost', 'undoAroundInterruptions', 'density',
    'groupRow', 'stratified', 'summarize', 'PRIMARY_TIER', 'REWORK_EXT_RE',
    'MIN_FRAGMENT_LEN', 'RESUME_PREFIX_RATIO', 'RESUME_MIN_COMMON',
    // 2026-11-14 加：返工需求率的两个随机窗口对照（审计期间新增，当时漏登记）。
    'redoShareAfterInterruptions', 'redoShareRandomWindows',
  ];
  for (const k of COST_FNS) REGISTERED.add(k);

  // measure-ask-vs-tell.mjs（2026-11-14 主指标重定义）：纯函数已全部进 PROBE_ARGS；
  // run / formatReport 要全量扫 2.1 GB，登记在 INTENTIONALLY_PROBED_FREE；
  // 常量与正则/冻结表是数据，不是函数。
  const ASK_VS_TELL_FNS = [
    'isAskCall', 'classifyExecHuman', 'isCostly', 'cwdOf', 'readAskTimeline',
    'sessionRow', 'density', 'countOf', 'perSessionDensity', 'cleanRate', 'groupRow',
    'densityDiffTest', 'cleanDiffTest', 'matchedOnWork', 'stratifyByWork',
    'summarize', 'formatReport',
    'ASK_TOOLS', 'COST_TIER', 'SECONDARY_TIERS', 'PER', 'MATCH_LOG_TOLERANCE',
    'PERM_ITERS', 'PERM_SEED', 'SANDBOX_RE', 'SANDBOX_SLUG_RE', 'TIER_FIELD',
    // isSandbox 与 observe-reality-check.mjs 里的同名导出重名：PROBE_ARGS 是按名字
    // 命中的扁平表，两个同名函数收到的参数完全不同（那边是 session 对象）。
    // 这里单独登记，不参加强制调用，避免用一个模块的形状去调另一个模块的函数。
    'isSandbox',
  ];
  for (const k of ASK_VS_TELL_FNS) REGISTERED.add(k);

  // pre-write-gate.mjs（2026-11-14 写前闸）：函数全部已进 PROBE_ARGS 实际调用，
  // 这里显式登记，免得被「未登记导出」提示刷屏。同名的六个导出
  // （decide / runHook / parseHookInput / readStdin / logPathFor / appendLog）
  // 也一并登记 —— 它们与 stop-verify-hook.mjs 重名，但探针是按名字命中所有模块的，
  // 所以上面那份停在那里的参数同样会把本文件的同名导出调一次。
  const PRE_WRITE_GATE_FNS = [
    'configOf', 'defaultConfig', 'markerPathFor', 'denialPathFor', 'pathKeyOf',
    'isGateOwnedPath', 'powershellWriteScan', 'writeIntentOf', 'readTranscriptReads',
    'readPathsOfToolUse', 'readPathsInTranscriptText', 'GATE_SHELL_READ_VERBS',
    'readMarker', 'writeMarker', 'markerValidity', 'reasonFor', 'bumpDenials', 'cli',
    // 2026-11-14 改动二：签名与密钥。ensureGateSecret 有写副作用，登记在 SANDBOX_ARGS。
    'markerSigOf', 'verifyMarkerSig', 'readGateSecret', 'ensureGateSecret', 'secretPathFor',
    'SECRET_REL', 'EDIT_SIDE_TOOLS',
    'decide', 'runHook', 'parseHookInput', 'readStdin', 'logPathFor', 'appendLog',
    'MARKER_REL', 'DENIAL_REL', 'MODES', 'BRAKES', 'DEFAULT_BUDGET_MS',
    'WRITE_TOOLS', 'SHELL_TOOLS', 'READ_TOOLS',
    // 2026-11-19 `ask.minQuestionsBeforeWrite`。三个函数已进 PROBE_ARGS 实际调用，
    // 这里显式登记免得被「未登记导出」刷屏。
    'readTranscriptActivity', 'minQuestionsBeforeWriteOf', 'reasonForQuestions', 'MAX_MIN_QUESTIONS',
    // 2026-11-19（`DF-038` 修复）：提问口径的唯一实现与回扫上限。两者都已进 PROBE_ARGS。
    'isAskToolName', 'DEFAULT_MAX_SCAN_BYTES',
  ];
  for (const k of PRE_WRITE_GATE_FNS) REGISTERED.add(k);

  // hook-dedupe.mjs（2026-11-18，`DF-029` 的幂等层）：三条会写盘的进 SANDBOX_ARGS
  // 真实调用一次（路径由 `_sandbox` 拼），其余是纯函数/常量。
  // 这一节必须存在：2026-11-18 之前 `checkUnregisteredExports` 自己因为
  // 「某个脚本 import 即打印 → JSON.parse 失败 → 静默 return」而**从来没跑过**，
  // 所以「未登记」这件事谁都看不见（见 `checkUnregisteredExports` 上方注释）。
  const HOOK_DEDUPE_FNS = [
    'claimKeyOf', 'claimPathFor', 'claimDirFor', 'dedupeRoot',
    'claimOnce', 'recordSkipped', 'sweepIfCrowded',
    'CLAIM_TTL_MS', 'SWEEP_AT', 'SKIPPED_FILE', 'DEDUPE_DIR_NAME',
  ];
  for (const k of HOOK_DEDUPE_FNS) REGISTERED.add(k);

  // make-social-preview.mjs（2026-11-18）：`renderPng` 已进 PROBE_ARGS 实际调用；
  // `main` 是 CLI 入口（写盘），由 make-social-preview.test.mjs 覆盖。
  for (const k of ['renderPng', 'main']) REGISTERED.add(k);

  // ── 同名但签名不同的导出：必须按模块分开探针 ─────────────────────────
  //
  // `PROBE_ARGS` 是一张**扁平**表，按名字命中所有模块。而这两个文件里
  // `runHook` / `decide` / `logPathFor` / `appendLog` / `readStdin` /
  // `parseHookInput` 同名但**签名不同**：
  //
  //   stop-verify-hook : runHook({ input, env })          —— 一个对象
  //   pre-write-gate   : runHook(input, { env, nowMs })   —— 两个位置参数
  //
  // 于是 stop hook 那份参数 `[{ input: {session_id:"probe",...} }]` 打到
  // `pre-write-gate.runHook` 上时，`input` 变成了 `{input:{...}}` ——
  // 它读不到 `cwd`，回落到 `process.cwd()`（= 仓库根），然后**真的往
  // 生产台账写一行** `sid=undefined / unparsable-input`。
  //
  // 2026-11-18 实测：这就是每次跑结构门 `pre-write-gate/<日期>.jsonl` +2 行的原因。
  // 只在探针全开时才出现（`DF-031` 把 66 条静默跳过的探针打开之后才暴露）——
  // 也就是说这个泄漏**一直被「不验证」掩盖着**。
  //
  // 修法：这几个名字**跳过强制调用**，由各自的专属探针验（见 `SANDBOX_ARGS`）。
  // 宁可少覆盖几个，也不要用 A 的形状去调 B —— 那产生的结论是假的。
  for (const k of CROSS_MODULE_SKIP) REGISTERED.add(k);

  // 2026-11-14 审计期间新加的三个探针脚本。它们是**一次性测量工具**，
  // 导出的是测量装置本身（读真实语料、算统计），不是被生产代码调用的纯函数。
  // 逐条登记避免刷屏；正确性由各自的报告里给出的复算命令覆盖。
  const AUDIT_PROBE_FNS = [
    // redteam-gate-evidence.mjs —— 读结果质量统计
    'readOutcomes', 'evidenceQuality', 'report',
    // redteam-gate-widening.mjs —— 逐会话消融与跨项目污染
    'gateReadsFixed', 'readPathsInText', 'tailText', 'evidenceSets',
    'isRealPathEvidence', 'subagentSet', 'predecessorCandidates', 'build',
    // probe-evidence-sources.mjs —— 证据来源四段探针
    'gateReadsFromToolUse', 'idNamespace', 'listMainTranscripts', 'subagentDirOf',
    'toolUsesOf', 'sectionA', 'sectionB', 'sectionC', 'sectionD',
  ];
  for (const k of AUDIT_PROBE_FNS) REGISTERED.add(k);

  // render-plan.mjs（2026-11-14 每轮开头一屏 plan）：渲染器的全部导出。
  // 它读 `tasks/runs/` 下的台账，测试用合成 graph + 注入 probe 覆盖（28 条），
  // 所以不塞进结构门的探针表；常量是数据（版本号 / 行数上限 / 行宽）。
  const RENDER_PLAN_FNS = [
    'PLAN_VERSION', 'MAX_LINES', 'ROW_WIDTH', 'VERIFIED_GLYPHS', 'ON_DEP_FAILED_MODES',
    'displayPath', 'findLatestRun', 'loadRun', 'formatPlan', 'buildPlan', 'renderPlan',
  ];
  for (const k of RENDER_PLAN_FNS) REGISTERED.add(k);

  // launch.mjs（2026-11-14 应用起宿主）：验收后补的三个导出。
  //   AUTH_RE / expectedAgents / maskDeep —— 它们**就是被测试直接 import 的**
  //   （2026-11-14 那条「负向测试没有牙」的教训：从源码正则提取被测物 = 自证，
  //   必须 import 真身，所以它们必须是导出）。
  const LAUNCH_FNS = ['AUTH_RE', 'expectedAgents', 'maskDeep', 'payloadInfo', 'verifyPluginRoot'];
  for (const k of LAUNCH_FNS) REGISTERED.add(k);

  // build-payload.mjs（2026-11-14 plugin 载荷生成）：纯函数已进 PROBE_ARGS 实际调用，
  // 这里显式登记，免得被「未登记导出」提示刷屏。
  // buildPayload 会**写盘**（rmSync + writeFileSync），main 是 CLI 入口 —— 两个都进
  // INTENTIONALLY_PROBED_FREE，由 build-payload.test.mjs 的 11 条生成/负向用例覆盖。
  // 常量是数据（目录名 / 文件名 / 版本号 / 帮助文本），不是函数。
  //
  // **这张表要跟 PROBE_ARGS 一起改。** 2026-11-21 加 `referencedScriptRoots` /
  // `scriptClosure`（DF-060）时只登记进了 `PROBE_ARGS`、忘了这张表，
  // 于是硬门每次都提示「这两个导出未登记」—— 而它们其实**正被探针真实调用**。
  // 这类「手工清单漂了」已在本仓复发多次（DF-031/DF-044/DF-047）。
  // 记在这里：加纯函数进 `PROBE_ARGS` 时，**同一处**也要加进这张表。
  const BUILD_PAYLOAD_FNS = [
    'PAYLOAD_VERSION', 'GENERATOR', 'MANIFEST_FILE', 'PLUGIN_NAME', 'DEFAULT_OUT',
    'AGENTS_REL', 'SKILLS_REL', 'HELP',
    'defaultOutDir', 'summarizeSources', 'payloadDigest', 'pluginManifest',
    'pluginManifestBytes', 'planPayload', 'checkPayload', 'parseArgv',
    'referencedScriptRoots', 'scriptClosure',
  ];
  for (const k of BUILD_PAYLOAD_FNS) REGISTERED.add(k);

  // observe-reality-check.mjs（2026-11-14 写前闸的真实语料重放）：纯函数已进 PROBE_ARGS，
  // 这里显式登记免得被「未登记导出」提示刷屏。buildReport / main 要扫 2GB 语料，
  // 与 measure-* 系列同处置 —— 由测试里的小目录端到端用例覆盖。
  const OBSERVE_REALITY_FNS = [
    'listTranscripts', 'isSandbox', 'eachLineOffset', 'recordSignature', 'verbsOf',
    'analyzeOne', 'gateReadsOf', 'broadReadsOf', 'tailGateReads', 'gateReadPathsInText',
    'dedupeForks', 'distOf', 'structuralKind', 'verdict', 'main', 'buildReport',
    'GATE_READ_VERBS', 'STRUCT_VERBS', 'CONTENT_VERBS', 'STRUCT_TOOLS', 'HERE',
    'CONTINUATION_RE', 'ATTRIBUTION_CLASSES',
    'isContinuation', 'agentToolIdsBefore', 'subagentReadsByToolId', 'looseSubagentReads', 'attribute',
  ];
  for (const k of OBSERVE_REALITY_FNS) REGISTERED.add(k);

  // compute-metrics.mjs（2026-11-23 走量指标）。判据层全进了 PROBE_ARGS 实际调用；
  // `run` / `main` / `listTranscripts` / `readRecords` / `metric1` / `metricVerdicts`
  // 要读全量 730 MB 语料（实测 16.8s 仅解析，全流程更久），与 measure-* 系列同处置 ——
  // 由 compute-metrics.test.mjs 在临时目录上的端到端用例覆盖（含 `--root` 空目录
  // 必须 exit 0、不存在的根必须 exit 2 两条）。
  //
  // 注意：PN 上那张 `PROBE_ARGS` 与这张 `REGISTERED` 是**两张表**，
  // 进前者只保证「被真调一次」，进后者才让「未登记」提示消失。两处都要加 ——
  // 本仓已有先例（DF-031/DF-044/DF-047），这里显式记一笔免得下一个人只加一张。
  const COMPUTE_METRICS_FNS = [
    // 常量与判据（PROBE_ARGS 里已真调；这里登记以免刷屏）
    'MIN_N_FOR_RATE', 'DEDUPE_KEYS', 'SANDBOX_RE', 'ACCEPT_VERDICT_RE', 'REDTEAM_BLOCK_RE',
    // 纯函数 —— 全部在 PROBE_ARGS 里被真调用过
    'foldUsage', 'parseAnchor', 'checkC2', 'checkAnchorResolvable',
    'findVerdicts', 'declaredOrdinal', 'claimsPriorFail', 'acSetOf',
    'verdictChains', 'attemptsToPass', 'census', 'countAcceptanceWork', 'pairAgentCalls',
    'buildReport', 'formatReport',
    // 读全量语料的入口：不进探针，由 compute-metrics.test.mjs 的端到端用例守
    'run', 'main', 'listTranscripts', 'readRecords', 'roleOf',
    'metric1', 'metricVerdicts', 'defaultRoot',
  ];
  for (const k of COMPUTE_METRICS_FNS) REGISTERED.add(k);

  // published-paths.mjs（`DF-039`：「可发布区零盘符」判据的唯一实现）。
  // 四个函数已进 PROBE_ARGS 实际调用（探针取一个不含任何路径的短串：必须安全返回
  // 空数组 / 原样字符串，不抛）。三个正则/表常量是**数据**，不是函数。
  // 2026-11-21 第二轮加了「无盘符前缀的本机标识符」判据（散列黑名单）：
  // `knownIdentifierKeyOf` / `findKnownIdentifiers` 进 PROBE_ARGS 实际调用，
  // `KNOWN_LOCAL_IDENTIFIERS` 是数据（而且**故意不可读回**，见该常量上方注释）。
  const PUBLISHED_PATHS_FNS = [
    'WIN_ABS_RE', 'POSIX_ABS_RE', 'PLACEHOLDER_LITERALS',
    'normalizePathHit', 'pathKeyOf', 'isPlaceholderPath',
    'findAbsolutePaths', 'publishedPathViolations',
    'KNOWN_LOCAL_IDENTIFIERS', 'knownIdentifierKeyOf', 'findKnownIdentifiers',
  ];
  for (const k of PUBLISHED_PATHS_FNS) REGISTERED.add(k);

  // link-check.mjs（`DF-040`：文档相对链接的唯一判据）。
  // 六条纯函数已进 PROBE_ARGS 实际调用；`markdownFiles` / `publishableFiles` /
  // `scanLinks` 要 spawn git 并遍历全仓（170 份 .md），**不能**进硬门 ——
  // 它们的正确性由 link-check.test.mjs 在临时目录里真的跑一遍覆盖。
  // `KIND_TEXT` 是数据（一张文案表），不是函数。
  const LINK_CHECK_FNS = [
    'KIND_TEXT',
    'stripCode', 'slugifyAnchor', 'anchorsOf', 'isExternalLink', 'linkOccurrences',
    'describeBroken', 'checkFileLinks', 'markdownFiles', 'publishableFiles', 'scanLinks',
  ];
  for (const k of LINK_CHECK_FNS) REGISTERED.add(k);

  // delivery-verdict.mjs（2026-11-22）：六条判定层函数已进 PROBE_ARGS 实际调用，
  // 这里显式登记免得被「未登记导出」刷屏。五个枚举与两张冻结表是**数据**，不是函数。
  const DELIVERY_FNS = [
    'RT_DISPATCH', 'RT_SEVERITY', 'VERDICTS', 'EVIDENCE_KINDS', 'COVERAGE_SECTIONS',
    'redteamItemProblems', 'isAnchored', 'coverageProblems', 'classifyEvidence',
    'parseAcceptorVerdict', 'deliverVerdict',
    // 2026-11-23（DF-080）：红队报告的读取入口与台账编号抽取。前两个进 PROBE_ARGS 真调；
    //  是 CLI 入口（读写盘），由 delivery-verdict.test.mjs 的子进程用例覆盖。
    'parseRedteamReport', 'deviationRefsFrom', 'main',
  ];
  for (const k of DELIVERY_FNS) REGISTERED.add(k);

  // dispatch-quartet.mjs（2026-11-23）：`outputFenceLines` / `quartetGaps` 已进 PROBE_ARGS
  // 实际调用（在 `dispatch-quartet.test.mjs` 里还有一组边界用例）。
  // `QUARTET_FIELDS` 是**字段名清单**（数据），不是函数，checkArgs 调不动它。
  const QUARTET_EXPORTS = ['QUARTET_FIELDS', 'outputFenceLines', 'quartetGaps'];
  for (const k of QUARTET_EXPORTS) REGISTERED.add(k);

  // roles.mjs（2026-11-21，DF-044）：角色注册表 —— 「有哪些角色」的唯一实现。
  // 纯函数与读盘函数都进了 PROBE_ARGS 实际调用；这里显式登记以免被「未登记导出」刷屏。
  // `defaultRoles` 不参加探针：它按模块顶层标志缓存，探一次之后结构门再 import
  // 拿到的就是那份缓存 —— 用缓存去证明「它能跑」是自证。它由 roles.test.mjs 的
  // 「12 份 id 逐字相同」那条用例真实调用（那条必须拿到真注册表）。
  // 两个路径常量是数据，不是函数。
  //
  // 2026-11-21（DF-062）：`AGENTS_DIR` 常量**被删了**，换成 `agentsDirCandidates(pkgRoot)`
  // 与 `agentsDir(pkgRoot)` —— 前者是两个候选的纯拼接，后者取第一个**有角色的**。
  // 删它的理由：常量在 plugin 载荷形态下指向 `<payload>/.claude/agents`，那里**不存在**
  // （角色在 `<payload>/agents`），于是载荷里的脚本认到 0 个角色。常量没法「按布局求值」。
  // 同日整改补的两个：`probeAgentsDir`（探测的完整结果，`sourceText` 的事实来源）、
  // `displayPath`（打印路径的唯一出口 —— 它替掉了 `sourceText` 里那段失效的相对化）。
  const ROLES_FNS = [
    'DEFAULT_AGENT_PREFIX', 'REPO_ROOT', 'agentsDirCandidates', 'agentsDir',
    'probeAgentsDir', 'displayPath',
    'defaultRoles', 'discoverRoles', 'parseFrontmatter', 'truthyFlag', 'readonlyOf',
    'bashScopeOf', 'BASH_SCOPES',
    'idFromName', 'resolveRole', 'roleIndex', 'labelOf', 'nameOf', 'agentPrefixFrom', 'FORBIDDEN_CONTEXT',
    // 2026-11-21（D2 验证）：按根求值的四个。`rolesFor` / `capabilitiesFor` 各进
    // PROBE_ARGS 真调一次（`rolesFor` 喂 null = 「只认框架」，`capabilitiesFor` 同）；
    // `rolesDirFor` 是纯路径拼接；`sourceText` 吃一份最小的注册表对象。
    // 它们的存在理由见 `roles.mjs` 的 `rolesFor`：常量在模块加载时求值 = 只认框架角色。
    'rolesFor', 'capabilitiesFor', 'rolesDirFor', 'sourceText',
  ];
  for (const k of ROLES_FNS) REGISTERED.add(k);

  // compose-agent-prompt.mjs（2026-11-14 提示词分层拼装）：判定层纯函数已进 PROBE_ARGS
  // 实际调用，这里显式登记免得被「未登记导出」刷屏。main 是 CLI 入口，
  // 由 compose-agent-prompt.test.mjs 的端到端用例覆盖。
  const COMPOSE_PROMPT_FNS = [
    'PROMPT_LEDGER_VERSION', 'PROMPT_LEDGER_FILE',
    'parseFrontmatter', 'roleTools', 'extractCommands', 'classifyRequirement', 'requiredTools',
    'stopConditionProblem', 'checkPromptSpec', 'deriveInjected', 'fillDispatchTemplate',
    'composePrompt', 'normalizeForHash', 'promptHash', 'makePromptRow', 'readPromptLedger',
    'firstUserText', 'readHeadRecords', 'subagentFiles', 'verifyPrompts', 'main',
    'LAYERS', 'OBLIGATION_KINDS', 'REQUIRED_ELEMENTS', 'REQUIRED_PLACEHOLDERS', 'FORBIDDEN_CONTEXT',
    // 契约 §8.2 的失败通知判据（2026-11-23）：判定层两条纯函数已进 PROBE_ARGS 实际调用；
    // 渲染函数已进 PROBE_ARGS（传一个合法类别）；枚举是数据。
    'FAILURE_CATEGORIES', 'failureNoticeText', 'failureNoticeProblem',
  ];
  for (const k of COMPOSE_PROMPT_FNS) REGISTERED.add(k);

  // measure-gate-ceiling.mjs：纯函数已进 PROBE_ARGS 实际调用，这里显式登记免得被
  // 「未登记导出」刷屏。measure / main 要全量扫 2GB 语料（实测 120s），与 measure-*
  // 系列同处置 —— 由 measure-gate-ceiling.test.mjs 的小目录端到端用例覆盖。
  const GATE_CEILING_FNS = [
    'gateReadsFixedOf', 'readWindowText', 'windowReadPaths', 'subagentPathSet',
    'looseSubagentPathSet', 'upstreamOf', 'toolCallCount', 'evidenceOf', 'variantSets',
    'contentReads', 'alignWithBaseline', 'parserEquivalence', 'byToolCalls', 'byDate',
    'dropLargestProject', 'measure', 'main', 'BASE_THRESHOLD', 'BASELINE_SNAPSHOT',
  ];
  for (const k of GATE_CEILING_FNS) REGISTERED.add(k);

  // question-audit.mjs（2026-11-14 提问形态审计）：判据层纯函数已进 PROBE_ARGS 实际调用，
  // 这里显式登记免得被「未登记导出」刷屏。scanCorpus / cli 要读全量语料（实测 22s），
  // 与 measure-* 系列同处置 —— 由 question-audit.test.mjs 的小目录端到端用例覆盖。
  const QUESTION_AUDIT_FNS = [
    'CONFIG_FILE', 'ASK_MODES', 'AUTO_COMPLEX_FILES', 'AUTO_COMPLEX_TOOLCALLS', 'KNOWN_ROLES',
    'questionsOfAsk', 'normalizeText', 'judgeReadFirst', 'judgeSession', 'summarize',
    'docTokenOverlap', 'nearDuplicateQuestions', 'scanSession', 'validateConfig', 'loadConfig',
    'formatReport', 'parseArgs', 'defaultConfig', 'exitCodeFor',
    'BLOCKING_CODES', 'ADVISORY_CODES',
    'scanCorpus', 'cli',
  ];
  for (const k of QUESTION_AUDIT_FNS) REGISTERED.add(k);

  // question-form.mjs（2026-11-19 从 question-audit 搬出的两个判据）：两个纯函数，
  // 参数已进 PROBE_ARGS（`questionsOfAsk` / `normalizeText` 本来就是那张表里的名字，
  // 探针按名字命中所有模块，所以搬过来之后它们的探针自动生效）。
  // 搬家的原因（避免 `pre-write-gate → question-audit → observe-reality-check → pre-write-gate`
  // 的 TDZ 环）见该文件头。这里显式登记，免得被「未登记导出」刷屏。
  for (const k of ['questionsOfAsk', 'normalizeText']) REGISTERED.add(k);

  // probe-parser-divergence.mjs（2026-11-14 量化重放器与闸门的分叉）：纯函数进 PROBE_ARGS，
  // `probe` 要扫全量语料，与 measure-* 系列同处置 —— 由 probe-parser-divergence.test.mjs
  // 的小目录用例覆盖。
  const PROBE_DIVERGENCE_FNS = [
    'gatePathsOfText', 'windowTextOf', 'diffOf', 'attributeDivergence',
    'syntheticCases', 'probe', 'formatProbe', 'main',
  ];
  for (const k of PROBE_DIVERGENCE_FNS) REGISTERED.add(k);

  // project-root.mjs（2026-11-21，「两个根」拆分）：判定层全部纯函数，已进 PROBE_ARGS
  // 实际调用（喂空 env + 不可达 cwd，走到第 5 级 —— 「找不到就返回 null」是正常分支）。
  // 两个常量是数据（`LEVELS` / `PROJECT_MARKERS`），checkArgs 调不动，一并登记。
  // 正确性由 `project-root.test.mjs` 的 27 条用例覆盖，其中两条是端到端（真起子进程）。
  const PROJECT_ROOT_FNS = [
    'frameworkRoot', 'resolveProjectRoot', 'projectRoot', 'rootFromArgv', 'searchUp',
    'levelText', 'formatTried', 'readPathsConfig', 'runsDirInfo', 'runsDirFor', 'main',
    'LEVELS', 'PROJECT_MARKERS', 'DEFAULT_RUNS_REL', 'ROOT_ENV', 'RUNS_DIR_ENV',
  ];
  for (const k of PROJECT_ROOT_FNS) REGISTERED.add(k);

  // stop-verify-hook.mjs 的 `ledgerRoot`：`resolveStateDir` 的别名（同一份判据，不是第二个），
  // 已进 PROBE_ARGS 用空 env 真调一次。行为由 stop-verify-hook.test.mjs 的三条默认路径断言守。
  REGISTERED.add('ledgerRoot');

  // regression-count.mjs（2026-11-21：「回归测试到底有多少条」的唯一取数处）。
  // **刻意不进 PROBE_ARGS**：它自己会 spawn 一个 node 子进程去 import 全部测试文件
  // （实测 1.0s）——让 `checkImportable` 再探一次，结构门就要多付一遍这个代价，
  // 而它此刻**正在本门里被真调用**（见 `checkTestCount()`），那才是真实覆盖。
  // 正确性由 `regression-count.test.mjs` 的红→绿用例守（含「循环注册要多算几条」）。
  REGISTERED.add('countRegisteredTests');

  // proc-liveness.mjs + watch.mjs 的判活层（DF-092 / DF-091，2026-11-24）。
  //
  // `REGISTERED` 与 `PROBE_ARGS`/`SANDBOX_ARGS` 是**两份**表：前者只影响「要不要
  // 提示未登记」，后者决定「会不会真被调用一次」。所以新导出必须在两处都登记 ——
  // 只登记 PROBE_ARGS 的话它会**真被调用**却仍然被提示「未登记」，
  // 而只登记这里则是「登记了但不探」。实测就是这样发现漏了一处的。
  //
  // 六个函数（makeNonce / livenessEndpoint / parseBeatFrame / stateOfErrorCode /
  // pidIsAlive / probeFailureReason）与两个常量（LIVENESS_PROTOCOL / BEAT_TIMEOUT_MS）
  // 与三张冻结表（PROBE_STATES / PROBE_OUTCOME / beatFrame）全部登记；
  // `startLivenessServer` / `probeLiveness` 有真副作用，进 INTENTIONALLY_PROBED_FREE。
  for (const k of [
    'makeNonce', 'livenessEndpoint', 'parseBeatFrame', 'stateOfErrorCode',
    'pidIsAlive', 'probeFailureReason',
    'LIVENESS_PROTOCOL', 'BEAT_TIMEOUT_MS', 'PROBE_STATES', 'PROBE_OUTCOME', 'beatFrame',
    'startLivenessServer', 'probeLiveness',
  ]) REGISTERED.add(k);
  // 两个文件发现判据是**纯函数**（只读目录、不执行任何东西），可以安全进 PROBE_ARGS：
  // 给一个不存在的目录，它们必须返回 false / []，不抛。
  // 它们必须真被调用一次：`isNodeTestFile` 写窄了的表现是「数不到」，而数不到不报错。
  REGISTERED.add('isNodeTestFile');
  REGISTERED.add('nodeTestFiles');

  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && !CLI_SCRIPTS.has(f));
  if (!files.length) return;

  // 一次性拿到所有文件的导出名：每个文件一个 import()，但只起一个 node 进程。
  const mods = files.map((f) => JSON.stringify('file:///' + join(dir, f).split(String.fromCharCode(92)).join('/')));
  const script =
    'Promise.all([' + mods.join(',') + '].map((u) => import(u).then((m) => Object.keys(m)).catch(() => [])))' +
    '.then((all) => console.log(JSON.stringify(all)))';
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) {
    // **不许静默 return。** 2026-11-18 实测：`import()` 一个「模块顶层就执行并打印」的脚本
    // （当时是 `make-social-preview.mjs`，后来是 `measure-checklist-coverage.mjs`）会把
    // 中文打到这个子进程的 stdout 上，于是下面那句 `JSON.parse` 必然失败，
    // 原来的 `catch { return; }` 就把**整项检查**放弃了 —— 而它的输出与
    // 「全部导出都登记过」逐字相同。这正是 `DF-031` 那个缺陷的同一种形态：
    // 静默跳过看起来和通过一样。
    //
    // 现在的处置分两层：
    //   · 子进程非 0 退出 → **fail**（import 都炸了，这一项根本没有结论）；
    //   · 解析不出 JSON   → **fail** 并指名是哪个文件污染了 stdout（可修的那种）。
    fail(SCRIPTS_REL + '/', `导出清单扫描的子进程以 ${r.status} 退出：${String(r.stderr || '').trim().split('\n')[0] || '无输出'}`);
    return;
  }
  let all;
  try {
    all = JSON.parse(String(r.stdout || '[]'));
  } catch {
    // 指名道姓：拿不到导出清单时，最可能的原因是某个模块 import 即执行。
    // 逐个 import 太慢（那是 40 个进程），所以只报现象 + 定位办法。
    fail(SCRIPTS_REL + '/', '导出清单不是合法 JSON —— 说明某个非测试脚本在**模块顶层**就往 stdout 打印了'
      + '（import 即执行）。这类脚本必须加「我是不是被直接执行」的入口守卫，'
      + '否则每次跑本门都会把它们真的执行一遍（副作用 + 输出污染）。'
      + ` 实测 stdout 前 80 字：${JSON.stringify(String(r.stdout || '').slice(0, 80))}`);
    return;
  }
  all.forEach((exportsList, i) => {
    for (const k of exportsList) {
      if (REGISTERED.has(k) || INTENTIONALLY_PROBED_FREE.has(k) || k === 'default') continue;
      warn(rel(join(dir, files[i])), `导出 "${k}" 未登记 —— 它不会被 checkImportable 调用。若是纯函数，请加进参数表；若有副作用，请加进 INTENTIONALLY_PROBED_FREE`);
    }
  });
}

/** CHANGELOG 硬规则：docs/CHANGELOG.md 自己规定「任何代码/配置/文档的更改都必须记入」，
 *  但在 2026-10-31 之前**没有任何门检查它** —— 实测有 18+ 个提交没有条目。
 *  规则没人执行就不叫规则，叫愿望。
 *
 *  检查方式：找出「最后一个被 CHANGELOG 引用过的 commit」到 HEAD 之间的全部提交，
 *  若有提交改动了源码/规格却没在 CHANGELOG 里留下 hash，即为违规。
 *
 *  为什么用 hash 而不用日期或行数：hash 是唯一无歧义的锚点，且本文件已经要求
 *  「每条必须写出处——commit hash」。要求写 hash，就该能验证 hash 在不在。
 *
 *  豁免：纯 CHANGELOG 自身的提交、以及 docs/runs 下的运行台账。 */
function checkChangelog() {
  const f = join(ROOT, 'docs', 'CHANGELOG.md');
  // CHANGELOG 是本产品自身的产物（它是「哪些改动没记账」的唯一判据来源）。
  // 这条曾是**决定性实验的直接对象**：把 `checkChangelog()` 从运行块里删掉，
  // 门照样 `✓`。文件缺失时同理 —— 旧版这里是 `return`，于是「CHANGELOG 被删」
  // 与「每个提交都记了账」在输出上完全同形。
  if (!requireProduct(f, 'docs/CHANGELOG.md')) return;
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { return; }

  const git = (args) => {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout || '') : null;
  };

  const log = git(['log', '--format=%h%x09%s', '-60']);
  if (log === null) return; // 不是 git 仓库（如解压后的发布包），跳过

  // CHANGELOG 里出现过的 7-40 位 hex 都当作「已记录」
  const recorded = new Set([...text.matchAll(/\b([0-9a-f]{7,40})\b/g)].map((m) => m[1]));
  const isRecorded = (h) => {
    for (const r of recorded) if (h.startsWith(r) || r.startsWith(h)) return true;
    return false;
  };

  const commits = log.trim().split('\n').filter(Boolean).map((l) => {
    const [h, subject] = l.split('\t');
    return { h, subject: subject || '' };
  });

  // 一个提交不可能在自己的内容里写自己的 hash —— 这是结构性的，不是疏漏。
  //
  // 第一版用「豁免 HEAD」处理（SKIP_HEAD = 1），结果是：每提交一次，上一个提交就
  // 变成新的违规项，修它又要再提交一次，再产生新的违规项。**无限后退**，
  // 而且每次 commit 之后 `check-structure` 都红。这正是它真跑起来时暴露的。
  //
  // 现在的规则有两条，合起来才闭环：
  //   1. **边界**：只检查「最近一次修改本文件的提交」之后的提交。
  //      历史欠账不追溯（追也追不动），但新的改动跑不掉。
  //   2. **自文档豁免**：改动了 `docs/CHANGELOG.md` 本身的提交视为已记录。
  //      它写的条目就是记录，再要求它引用自己的 hash 是把记账当成了目的。
  //
  // 剩下的：既没动 CHANGELOG、又改了源码/规格、又没被任何 hash 引用 —— 那才是真欠账。
  const SOURCE_RE = /^(scripts\/|\.claude\/|docs\/|templates\/|rules\/|README\.md|CLAUDE\.md)/;
  const SKIP_RE = /^(tasks\/runs\/)/;

  let boundary = -1;
  for (let i = 0; i < commits.length; i++) {
    const files = git(['show', '--name-only', '--format=', commits[i].h]);
    if (files && files.trim().split('\n').includes('docs/CHANGELOG.md')) { boundary = i; break; }
  }
  if (boundary <= 0) return; // 最近一次提交就改了 CHANGELOG，或找不到边界：没有可检查范围

  const missing = [];
  for (let i = 0; i < boundary; i++) {
    const { h, subject } = commits[i];
    const files = git(['show', '--name-only', '--format=', h]);
    if (files === null) continue;
    const touched = files.trim().split('\n').filter(Boolean)
      .filter((p) => SOURCE_RE.test(p) && !SKIP_RE.test(p));
    if (!touched.length) continue;
    missing.push(`${h} ${subject.slice(0, 50)}`);
  }

  if (missing.length) {
    fail('docs/CHANGELOG.md',
      `${missing.length} 个提交改动了源码/规格但没有 CHANGELOG 条目（本文件自己规定的硬规则）：\n      ` +
      missing.slice(0, 8).join('\n      ') +
      (missing.length > 8 ? `\n      …还有 ${missing.length - 8} 个` : ''));
  }
}

/** 闸门门禁：把 Stop hook 的默认值改成 `block`，必须同时具备用户叫停路径。
 *
 *  **为什么这条必须是硬门而不是注释**：一个默认开启的强拦如果不给出叫停路径，
 *  就是把用户锁在自己的会话里。真实事故（issue #108493）：用户说
 *  「stop everything, you are done」之后，会话又起了子 agent 和一次外部 run 并截图。
 *
 *  设计（`docs/` 里「停要带 delta」§4）要求三层：
 *    L1 文件闸   `isPaused()` + `pausePathFor()` —— 与上下文无关的一层
 *    L2 用户发话 `userIntervenedSince()` —— 用户已经说话了（事故里正是这种）
 *    L3 预算耗尽 `allowed-budget-exhausted` —— 闸门用完配额这件事必须可见
 *
 *  检查只在 `modeOf()` 的默认返回变成 `'block'` 时生效，所以现在是**空转**的 ——
 *  那是对的：门禁的价值在于「有人想开门时它拦得住」，不在于现在报什么。
 *  硬门里已经有同类先例（`checkLauncherPlacement` / `checkInboxWiring`）。 */
function checkStopHookKillSwitch() {
  const file = join(SCRIPTS_DIR, 'stop-verify-hook.mjs');
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { return; }

  // 取 `modeOf()` 的函数体，判它的默认分支返回什么。
  const m = src.match(/export function modeOf\([\s\S]*?\n\}/);
  if (!m) return;
  const body = m[0];
  // `return 'block'` 出现在默认路径上（而不是只在某个 if 分支里）就算「默认开」。
  // 判据刻意保守：只在**找不到任何 `return 'off'`** 时才认为默认是 block。
  const defaultsToBlock = !/return\s+'off'/.test(body) && /return\s+'block'/.test(body);
  if (!defaultsToBlock) return;

  // **判据必须是「可调用」，不是「字符串出现过」。**
  // 第一版只查 `src.includes('userIntervenedSince')`，于是把 `export function` 改名成
  // `function` 之后门禁照样通过 —— 实现还在文件里，只是再也调不到。这正是本仓反复
  // 批判的那类判据（「看见 ≠ 判红」）。
  //
  // 现在查两种形态：`export function X(` / `export const X =`（可被外部调用），
  // 以及 `runHook` 里真的有对应分支（`isPaused(env)` / `userIntervenedSince(` 的调用点）。
  const hasExport = (name) => new RegExp(
    `export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(|export\\s+const\\s+${name}\\s*=`,
  ).test(src);
  // 调用点判据不能拿 `src.includes('X(')` —— 它会被**函数定义那一行本身**命中
  // （`export function X(` 里也有 `X(`）。第一版正是这么漏掉的：把 `runHook` 里的
  // 调用删干净，门禁照样通过。所以逐行看，且跳过声明行。
  const hasCall = (name) => src.split('\n').some((line) => {
    if (!line.includes(`${name}(`)) return false;
    if (/^\s*(export\s+)?(async\s+)?function\s+/.test(line)) return false; // 定义行
    if (/^\s*export\s+const\s+/.test(line)) return false;
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return false;                    // 注释行
    return true;
  });

  const required = [
    { name: 'isPaused', call: 'isPaused', label: 'L1 文件闸（`isPaused()` 且真被调用）' },
    { name: 'pausePathFor', call: 'pausePathFor', label: 'L1 闸门文件路径（可调用）' },
    // `DF-041`：叫停路径必须是一**族**而不是一个。判据是「有可调用的导出 + 有调用点」——
    // 退回硬编码单个路径的形态会让 `pausePathsFor` 连同旧目录的兼容一起消失，
    // 而那正是「闸关不掉」的成因。
    { name: 'pausePathsFor', call: 'pausePathsFor', label: 'L1 叫停路径族（`pausePathsFor()` 且真被调用）' },
    { name: 'pausedPathOf', call: 'pausedPathOf', label: 'L1 命中路径（`pausedPathOf()` 且真被调用 —— 可观测性）' },
    { name: 'userIntervenedSince', call: 'userIntervenedSince', label: 'L2 用户发话（`userIntervenedSince()` 且真被调用）' },
  ];
  const missing = [];
  for (const r of required) {
    if (!hasExport(r.name)) { missing.push(`${r.label} —— 没有可调用的导出`); continue; }
    if (!hasCall(r.call)) missing.push(`${r.label} —— 导出了但没有调用点`);
  }
  // 两个 outcome 标记与预算耗尽标记：它们是**可见性**，只需要出现。
  for (const [needle, label] of [
    ['allowed-user-paused', 'L1 的 outcome 标记'],
    ['allowed-user-intervened', 'L2 的 outcome 标记'],
    ['allowed-budget-exhausted', 'L3 预算耗尽可见'],
  ]) {
    if (!src.includes(needle)) missing.push(label);
  }
  if (missing.length) {
    fail(`${SCRIPTS_REL}/stop-verify-hook.mjs`,
      `modeOf() 默认返回 'block'（闸门默认开启），但缺少用户叫停路径：\n      `
      + missing.join('\n      ')
      + '\n      一个默认开启的强拦不给叫停路径 = 把用户锁在会话里。见本函数上方注释。');
  }
}

/** 台账格式门：两本台账是「不自行修」这条纪律的载体。
 *  纪律靠格式维持，格式坏了纪律就悄悄消失 —— 例如把所有条目都标成 [fixed]，
 *  台账看起来干净，实际是「没人往里面加」。2026-10-31 实测：14 条里 14 条 fixed，
 *  一个开放项都没有，而同一时期明确发现了 5 个未修问题。
 *
 *  这里不检查「应该有多少 open」（那是判断，不是事实），只检查**格式合法性**：
 *  状态必须在枚举内、每个条目必须有发现位置、ledger 不能全是 fixed 而文件里还有 open 字样。 */
function checkLedger() {
  // **状态枚举。`partially fixed` 是合法的两个词状态**（DF-043、DF-070 在用）。
  //
  // 2026-11-21 之前这里的三个正则都是 `\[([a-z]+)\]` —— 只认连续小写字母。
  // 于是 `[partially fixed]`（带空格）、`[bogus-state]`（带连字符）**一条都匹配不上**，
  // 既不在枚举校验里、也不进 open 计数。实测：台账 72 条，正则只看到 **70** 条，
  // DF-043 与 DF-070 完全隐形。
  //
  // 而这个函数的注释写着「台账是『还有多少债』的唯一来源」（下面 :2106 附近）——
  // 唯一来源漏了 2 条债。这正是本仓最稳定的缺陷形态：**判据在跑，但它看不见一部分输入，
  // 而屏幕上是绿的**（DF-059 记的就是这个洞，当时只测了 `[bogus]` 这种纯小写的，
  // 所以没发现带空格/连字符的也会漏）。
  //
  // 修法：**先用宽正则把所有 `[xxx]` 抓出来，再判它在不在枚举里**。
  // 顺序反过来的话，「非法状态」会先被窄正则筛掉，于是「非法」变成「不存在」——
  // 这正是修前的行为。
  const ENUM = new Set(['open', 'triaged', 'scheduled', 'fixed', 'wontfix', 'partially fixed']);

  const df = join(ROOT, 'tasks', 'dev-findings.md');
  if (existsSync(df)) {
    let text;
    try { text = readFileSync(df, 'utf8'); } catch { text = ''; }
    // 标题里的状态必须与正文 `**状态**：xxx` 一致。
    // 2026-10-31 实测：DF-020 标题写 [open]、正文写 fixed，两个地方对不上，
    // 而台账是「还有多少债」的唯一来源。不一致的台账比没有台账更坏。
    for (const b of text.split(/^### /m).slice(1)) {
      const head = b.match(/^(DF-\d{3}) \[([^\]]+)\]/);
      if (!head) continue;
      const body = b.match(/\*\*状态\*\*[：:]\s*([a-z ]+)/);
      if (!body) continue;
      if (body[1].trim() !== head[2]) {
        fail('tasks/dev-findings.md', `${head[1]} 标题写 [${head[2]}]，正文写 ${body[1].trim()} —— 状态不一致`);
      }
    }

    const entries = [...text.matchAll(/^### (DF-\d{3}) \[([^\]]+)\]/gm)];
    const real = entries.filter(([, , st]) => ENUM.has(st));
    const bad = entries.filter(([, , st]) => !ENUM.has(st));
    for (const [, id, st] of bad) {
      fail('tasks/dev-findings.md', `${id} 的状态 "${st}" 不在枚举内（${[...ENUM].join(' / ')}）`);
    }
    if (!real.length) {
      warn('tasks/dev-findings.md', '没有识别到任何 DF-xxx 条目 —— 台账可能是空的，或格式变了');
    } else {
      const open = real.filter(([, , st]) => st === 'open' || st === 'triaged' || st === 'scheduled' || st === 'partially fixed').length;
      // 只提示，不阻塞：全 fixed 可能是真的都修完了。但值得每次看见，因为更常见的是没人往里加。
      if (open === 0) {
        warn('tasks/dev-findings.md', `${real.length} 条全部已收口，0 个开放项 —— 确认这是事实，而不是没人登记`);
      }
    }
  }

  const ad = join(ROOT, 'tasks', 'accepted-deviations.md');
  if (existsSync(ad)) {
    let text;
    try { text = readFileSync(ad, 'utf8'); } catch { text = ''; }
    // 每条已知偏差必须写明「为什么不修」，否则它只是一条待办
    const blocks = text.split(/^### /m).slice(1);
    for (const b of blocks) {
      const id = (b.match(/^([\w-]+)/) || [])[1] || '(无编号)';
      if (!/为什么|理由|代价/.test(b)) {
        fail('tasks/accepted-deviations.md', `${id} 没有写明不修的理由 —— 没写理由的偏差就是一条待办`);
      }
    }
  }
}

/** DF-022：启动器绝不能落在数据目录里。
 *
 *  那是真实发生过的事故：start-watch.vbs 住在 %LOCALAPPDATA%\Overwatch\ 里，
 *  而那个目录正是它要保护的。一次整目录删除把启动器和数据一起删掉，
 *  监控系统就此起不来——数据能重新积累，起不来则永远没有积累的机会。
 *
 *  这里把位置关系变成可执行的检查，而不是靠安装文档里的一句话。 */
function checkLauncherPlacement() {
  const installDir = join(SCRIPTS_DIR, 'install');
  const tpl = join(installDir, 'start-watch.vbs.template');
  const out = join(installDir, 'start-watch.vbs');
  const TPL_REL = `${SCRIPTS_REL}/install/start-watch.vbs.template`;
  // 启动器模板是本产品自身的产物（VBScript 启动器是我们的交付物）。
  if (!requireProduct(tpl, TPL_REL)) return;
  let raw;
  try { raw = readFileSync(tpl, 'utf8'); } catch (e) {
    fail(TPL_REL, `读不了模板：${e.message}`);
    return;
  }
  for (const ph of ['__REPO__', '__STATE_DIR__']) {
    if (!raw.includes(ph)) {
      fail(TPL_REL, `模板缺少占位符 ${ph}`);
    }
  }
  // 模板必须纯 ASCII：VBScript 按 ANSI 读，非 ASCII 会截断字符串字面量
  const bad = [...new Set([...raw].filter((ch) => ch.charCodeAt(0) > 127))];
  if (bad.length) {
    fail(TPL_REL,
      `模板含非 ASCII 字符 ${JSON.stringify(bad.join(''))}——VBScript 会误读并截断字符串`);
  }
  // 若产物已生成，它必须在仓库内（即不在数据目录）
  if (existsSync(out)) {
    const rel = relative(ROOT, out);
    if (rel.startsWith('..')) {
      fail(rel, '启动器产物落在仓库外——它必须与数据目录分离');
    }
  }
}

/** DF-015：监控与调度必须保持连通。
 *
 *  两半曾经彻底断开：`watch.mjs` 后台发现 WAITING 并发通知，而 12 个 agent 定义里
 *  零个引用它，SKILL.md 也只调 `scan-sessions.mjs`。主线程永远不知道后台看见过什么，
 *  两边各自重扫，既慢又不一致。
 *
 *  修法是「一份数据两个消费者」：watch 把发现写进 `state.notified`，
 *  调度侧用 `--inbox` 读同一份。这条检查保证**接口不会再次悄悄断掉**——
 *  文档写了但没人调用，和没写是一样的。 */
function checkInboxWiring() {
  const skill = join(ROOT, CFG.skillPath);
  if (existsSync(skill)) {
    let t = '';
    try { t = readFileSync(skill, 'utf8'); } catch { /* ignore */ }
    if (!t.includes('asked.mjs')) {
      fail(CFG.skillPath,
        '调度入口没有引用 asked.mjs —— 宿主不报的「问了没答」会话会被完全漏掉');
    }
    if (!t.includes('validate-run.mjs')) {
      fail(CFG.skillPath,
        '规划阶段没有引用 validate-run.mjs —— planner 的产物没人校验（硬约束 4/8）');
    }
    if (!t.includes('--health')) {
      fail(CFG.skillPath,
        '调度入口没有引用 `watch.mjs --health` —— 无法区分「进程死了」和「进程卡住了」（DF-023）');
    }
    if (!t.includes('--inbox')) {
      fail(CFG.skillPath,
        '调度入口没有引用 `watch.mjs --inbox` —— 后台发现又接不上了（DF-015）');
    }
  }
  // 至少一个 agent 必须知道收件箱存在，否则派出去的 agent 会各自重扫。
  const agentDir = AGENTS_DIR;
  if (existsSync(agentDir)) {
    const files = readdirSync(agentDir).filter((f) => f.endsWith('.md'));
    const refs = files.filter((f) => {
      try { return readFileSync(join(agentDir, f), 'utf8').includes('--inbox'); } catch { return false; }
    });
    if (files.length && !refs.length) {
      // 数字**不写死**：`12 个角色定义` 是收敛前的快照，加一个角色它就变成假话，
      // 而它是**报错文案里**的一句 —— 假话报错比不报还糟（读者会去数，然后不再相信这个门）。
      // 实际个数从刚数出来的 `files` 取。
      fail(`${AGENTS_REL}/`, `${files.length} 个角色定义里没有一个引用 --inbox —— 监控与调度脱节（DF-015）`);
    }
  }
  // 脚本侧必须真的实现了这个命令
  const w = join(SCRIPTS_DIR, 'watch.mjs');
  if (existsSync(w)) {
    let t = '';
    try { t = readFileSync(w, 'utf8'); } catch { /* ignore */ }
    if (!t.includes("flags.has('--health')")) {
      fail(`${SCRIPTS_REL}/watch.mjs`, '脚本没有实现 --health，但文档在引用它');
    }
    if (!t.includes("flags.has('--inbox')")) {
      fail(`${SCRIPTS_REL}/watch.mjs`, '脚本没有实现 --inbox，但文档在引用它');
    }
  }
}

/** DF-042：SKILL.md 必须引用 `compose-agent-prompt`。
 *
 *  与 `checkInboxWiring()` 同一个模式，理由也相同：`compose-agent-prompt.mjs` 的
 *  `FORBIDDEN_CONTEXT`（锐评不得拿到执行者的自我评价）与 `REQUIRED_ELEMENTS`
 *  都写好了、也测过了，但 2026-11-21 实测它在 `.claude/` / `templates/` / `docs/`
 *  里**零引用**，且 CLI 两处硬传 `context: {}`——于是那条检查在真实调用中恒真。
 *  「定义里写得再对，没人调用等于不存在」（DF-015 的原话）。
 *
 *  守三件事，缺一件这条链就是断的：
 *    1. `.claude/skills/oversight/SKILL.md` 的 Phase B 提到 `compose-agent-prompt`
 *    2. 它提到 `--context-from`（否则「补充上下文」这条路又缩回「谁都不许给」）
 *    3. 脚本侧真的实现了这个参数（文档承诺不能跑在代码前面）
 *
 *  **不检查 `--gate` / `--stop`**：那两个在 SKILL.md 里是示例的一部分，
 *  而 Gate 判断「有没有写进示例」对「参数存不存在」没有增量信息——
 *  `checkCapabilities()` 已经在守「文档里的参数必须被脚本支持」。 */
function checkPromptWiring() {
  const skill = join(ROOT, CFG.skillPath);
  if (existsSync(skill)) {
    let t = '';
    try { t = readFileSync(skill, 'utf8'); } catch { /* ignore */ }
    if (!t.includes('compose-agent-prompt')) {
      fail(CFG.skillPath,
        '派发阶段没有引用 compose-agent-prompt.mjs —— 提示词又回到手填，'
        + 'FORBIDDEN_CONTEXT 与 REQUIRED_ELEMENTS 两项检查在真实调用中永不生效（DF-042）');
    }
    if (!t.includes('--context-from')) {
      fail(CFG.skillPath,
        '没有引用 --context-from —— 「给某个角色补材料」只剩 CLI 私下的路，'
        + '而 FORBIDDEN_CONTEXT 只有这一条入口会被喂到（DF-042）');
    }
  }
  // 文档承诺必须落在代码上：SKILL.md 说支持，脚本事得真有
  const c = join(SCRIPTS_DIR, 'compose-agent-prompt.mjs');
  if (existsSync(c)) {
    let t = '';
    try { t = readFileSync(c, 'utf8'); } catch { /* ignore */ }
    if (!t.includes("args['context-from']")) {
      fail(`${SCRIPTS_REL}/compose-agent-prompt.mjs`,
        'SKILL.md 在教人用 --context-from，但脚本没有实现它');
    }
  }
}

/** 证据分层与红队三档：**规范里的枚举必须与代码逐字一致**（2026-11-22）。
 *
 *  ## 为什么需要这条
 *
 *  这是 `checkPromptWiring()` 的同一个模式。`docs/spec/evidence-discipline.md` §9
 *  写下了红队三档 `block` / `accept` / `advisory` 与两个强 `kind` 集合，
 *  而那是**散文** —— 散文里的枚举与 `delivery-verdict.mjs` 里的数组没有任何机制
 *  保证一致。改代码不改文档（或反过来）时，屏幕上是绿的，
 *  而读到规范的人会按一个不存在的档位去判 —— 正是 DF-042 的形态。
 *
 *  ## 判据（三条，都可机械判定）
 *
 *    1. `RT_DISPATCH` 的值必须**逐个**出现在规范 §9 的表格里
 *    2. 强证据的 `kind` 必须全部出现在规范 §1.5 里（弱证据同理）
 *    3. 规范里必须出现「缺省不是 `advisory`」这一条 —— 它是三档设计里唯一
 *       不看代码就看不出来的约定（少了它，读者会把缺省当成 advisory）
 *
 *  **不检查措辞**：规范怎么说这些档位是给人读的，门只管「枚举值一个不缺」。
 *  「写得够不够清楚」不可机械判定，硬要检查会退化成「请务必包含」。 */
function checkEvidenceTaxonomy() {
  const doc = join(ROOT, 'docs', 'spec', 'evidence-discipline.md');
  if (!requireProduct(doc, 'docs/spec/evidence-discipline.md')) return;
  let text = '';
  try { text = readFileSync(doc, 'utf8'); } catch { return; }
  const mod = join(SCRIPTS_DIR, 'delivery-verdict.mjs');
  if (!requirePath(mod, `${SCRIPTS_REL}/delivery-verdict.mjs`)) return;
  let src = '';
  try { src = readFileSync(mod, 'utf8'); } catch { return; }

  // 从源码里读枚举的**值**（不是从 import 读：门要能在模块坏掉时报出原因，
  // 而 import 失败会让这条检查变成「没跑」，与「通过」同形）。
  const arrayOf = (name) => {
    const m = new RegExp(`${name}\\s*=\\s*Object\\.freeze\\(\\[([^\\]]*)\\]`).exec(src);
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
  };
  const dispatch = arrayOf('RT_DISPATCH');
  if (!dispatch) {
    fail(`${SCRIPTS_REL}/delivery-verdict.mjs`, '读不出 RT_DISPATCH 的三档枚举 —— '
      + '这条规范与代码的一致性检查因此没有对象（门不许静默放行）');
    return;
  }
  for (const d of dispatch) {
    // 判据必须锚在**表格行**上，不能只判「全文里出现过这个词」。
    // 实测踩过：`block` 在正文别处也会出现（`redteam_block`、`dispatch=block` 的说明文字），
    // 于是「把三档表格里那一行删掉」不会红 —— 一条永远绿的检查比没有更坏。
    //
    // 现在要求：存在一行以 `| \`<档位>\` |` 开头的表格行。这是三档表格的固定形状。
    const rowRe = new RegExp(`^\\|\\s*\`${d}\`\\s*\\|`, 'm');
    if (!rowRe.test(text)) {
      fail('docs/spec/evidence-discipline.md', `三档表格里没有 \`${d}\` 这一行 —— `
        + '代码里有这一档，规范里没有：读到规范的人会按一个不存在的档位判');
    }
  }
  // 强 / 弱 evidence kind：从 EVIDENCE_KINDS 的对象字面量里取键名。
  const kinds = [...src.matchAll(/^\s{2}(\w+):\s*\{\s*strong:\s*(true|false)/gm)]
    .map((m) => ({ kind: m[1], strong: m[2] === 'true' }));
  if (!kinds.length) {
    fail(`${SCRIPTS_REL}/delivery-verdict.mjs`, '读不出 EVIDENCE_KINDS —— 证据分层的一致性检查没有对象');
    return;
  }
  for (const { kind, strong } of kinds) {
    if (!new RegExp(`\\b${kind}\\b`).test(text)) {
      fail('docs/spec/evidence-discipline.md',
        `代码里的证据类型 "${kind}"（${strong ? '强' : '弱'}）在规范里没有出现`);
    }
  }
  // 三档设计里唯一「不看代码看不出来」的那条约定。
  //
  // 判据刻意宽松到「缺省」与「advisory」在同一行出现即可：这一条的意思可以用
  // 好几种写法表达（「缺省不是 advisory」/「不许缺省成它」/「为什么缺省不能是」），
  // 而收紧到某一种具体句式，会让规范作者换一个更准确的措辞时**门反而红** ——
  // 那会逼人为了过门去写一句更差的话。
  const defaultClause = text.split('\n').some((l) => /缺省/.test(l) && /advisory/.test(l));
  if (!defaultClause) {
    fail('docs/spec/evidence-discipline.md',
      '没有写明「dispatch 缺省不是 advisory」—— 少了这一句，读者会把「没写」当成「不阻断」，'
      + '而那正是静默放行');
  }
}

/** DF-016：设计文档必须标明「未实现」，且索引必须覆盖每一份。
 *
 *  970 行设计文档描述的能力一行代码都没有，而在此之前**没有任何入口指向它们**——
 *  读者只知道仓库里有这个目录，不知道里面是什么。
 *
 *  这里守住三件事：
 *    1. design/README.md 存在（索引本身不能没有）
 *    2. design/ 下每一份 .md 都在索引里被提到（新增文档不能绕过索引）
 *    3. 索引里必须出现「未实现」字样（不能哪天被悄悄改成「部分实现」）
 */
function checkDesignIndex() {
  const dir = join(ROOT, 'docs', 'design');
  // `docs/design/` 是本产品自身的产物（15 份设计稿被跟踪且发布）。缺了 = 本仓坏了。
  // 别人的项目没有设计推演目录是**正常的** —— 所以用 `requireProduct()`（DF-051）。
  //
  // 旧版 `return` 的后果：整个 docs/design 被删掉时门仍然 `✓` ——
  // 而这条检查的全部意义就是「别让读者以为设计稿描述的是已实现能力」。
  // 现在本仓里缺了照样红；只是别人的项目里不再无中生有。
  if (!requireProduct(dir, 'docs/design')) return;
  const index = join(dir, 'README.md');
  // 索引存在就必须合法 —— 缺了本仓红、别人记「没跑」。
  if (!requireProduct(index, 'docs/design/README.md')) return;
  let idx = '';
  try { idx = readFileSync(index, 'utf8'); } catch { /* ignore */ }
  if (!/未实现/.test(idx)) {
    fail('docs/design/README.md', '索引必须明确写出这些文档描述的能力「未实现」');
  }
  const docs = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  for (const f of docs) {
    if (!idx.includes(f)) {
      fail('docs/design/README.md', `${f} 没有被索引提到——新增设计文档必须登记状态`);
    }
  }
  // 入口必须指向索引：否则还是没人会点进去。
  // 「入口必须指向设计索引」是本产品自身的规矩（我们的 README 有这一节）。
  // 别人的 README 没有 `docs/design/`，要求它指向一个不存在的目录是荒谬的。
  for (const entry of ['README.md', 'CLAUDE.md']) {
    const p = join(ROOT, entry);
    if (!requireProduct(p, entry)) continue;
    let t = '';
    try { t = readFileSync(p, 'utf8'); } catch { /* ignore */ }
    if (!t.includes('docs/design/README.md')) {
      fail(entry, '没有指向 docs/design/README.md —— 读者找不到设计文档的状态说明');
    }
  }
}

/** 定义了但从不派发的 agent = 死代码。
 *
 *  2026-11-01 实测：`oversight-probe` 的角色定义存在、触发条件还专门改过，
 *  但 SKILL.md **从不派它**——它的触发条件永远不会生效。
 *  定义里写得再对，没人调用就等于不存在。
 *
 *  检查：agents/ 下每个角色，至少要在 SKILL.md 里被提到一次。
 *  豁免：明确标注「由其他 agent 派生」的角色（目前没有，但留出口）。 */
function checkAgentReachability() {
  const agentDir = AGENTS_DIR;
  const skill = join(ROOT, CFG.skillPath);
  // 复合守卫**必须拆开**：合成一句的话，两个缺失原因的处置被混成一个。
  //   角色目录缺失 = 仓库坏了（规定产物）→ fail
  //   调度入口缺失 = 规定产物 → fail
  // 旧版把两者一起 `return`，于是「12 个角色定义了却从不被派发」这条检查在
  // 任何一处缺失时都静默消失。
  if (!requirePath(agentDir, AGENTS_REL)) return;
  if (!requirePath(skill, CFG.skillPath)) return;
  let sk = '';
  try { sk = readFileSync(skill, 'utf8'); } catch { return; }
  const files = readdirSync(agentDir).filter((f) => f.endsWith('.md'));
  const orphans = [];
  for (const f of files) {
    const name = f.replace(/\.md$/, '');
    let body = '';
    try { body = readFileSync(join(agentDir, f), 'utf8'); } catch { continue; }
    // 允许角色自己在 frontmatter 里声明「不由 SKILL 直接派发」
    if (/dispatched-by:\s*other/.test(body)) continue;
    if (!sk.includes(name)) orphans.push(name);
  }
  if (orphans.length) {
    fail(CFG.skillPath,
      `这些角色定义了却从不被派发：${orphans.join(', ')} —— 定义里写得再对，没人调用等于不存在`);
  }
}

/** 检查：**主线程自述核验角色必须真的被派发**（DF-082，2026-11-23）。
 *
 *  ## 它守的是什么
 *
 *  `oversight-verifier` 是本仓第一个**核主线程自己**的角色。它的失效方式与
 *  `oversight-probe` 逐字相同（SKILL.md 曾从不派它，见 §0.5 的注记）：
 *  角色定义写得再对，SKILL.md 不提它，它就永远不会被调用。
 *  而**一个从不被派发的核验角色比没有更坏** —— 它会让「主线程的话被核过了」
 *  成为一个看起来成立的断言。所以这条不是「建议提及」，是硬门。
 *
 *  ## 判据（三条，都可机械判定）
 *
 *  1. 角色文件 `.claude/agents/oversight-verifier.md` 存在 —— 缺了是仓库坏了；
 *  2. 它的 `tools:` 里**不得**有派生工具（`Task` / `Agent`）：它必须是叶子，
 *     否则 §7 的「深度恒 1」当场失效，而那一节有整整一份论证挂在这个事实上；
 *  3. SKILL.md 必须真的把它派发出去：出现派发动词，而不只是出现名字。
 *     只判「名字出现过」会被一句「（`oversight-verifier` 存在但本轮不用）」满足，
 *     而那正是 `oversight-probe` 当年落到的形态 —— 名字在，从没派。
 *
 *  ## 为什么把「深度」也放在这条检查里
 *
 *  `checkDispatchDepth()` 取的是**全部角色 tools 的并集**（只要有一个能派生，深度就 ≥2）。
 *  也就是说：给 verifier 加一个 `Agent` 会让**那条**检查去报「文档说深度是 1」——
 *  红在对的地方，但报错指向文档，而真正要改的是这个角色的工具白名单。
 *  这里补一条指名道姓的判据，让报错落在角色本身上。 */
function checkHubVerifier() {
  const rel = `${AGENTS_REL}/oversight-verifier.md`;
  const abs = join(AGENTS_DIR, 'oversight-verifier.md');
  if (!requirePath(abs, rel)) return;
  let body = '';
  try { body = readFileSync(abs, 'utf8'); } catch {
    fail(rel, '读不出来 —— 这条检查因此没有对象');
    return;
  }
  const toolsLine = body.match(/^tools:\s*(.+)$/m);
  if (!toolsLine) {
    fail(rel, 'frontmatter 缺 tools 整行 —— 宿主语义是「继承全部工具」，'
      + '一个核验角色拿到全部工具就不再是核验角色');
  } else {
    const tools = toolsLine[1].split(',').map((t) => t.trim());
    const derive = tools.filter((t) => t === 'Task' || t === 'Agent');
    if (derive.length) {
      fail(rel, `tools 里含派生工具 ${derive.join(', ')} —— oversight-verifier 必须是叶子：`
        + '它一旦能派生，§7 的「深度恒为 1 层」当场失效，而那一节有一整份论证挂在这个事实上');
    }
  }
  // 判据必须是「真的派发」，不是「提过名字」。
  const skill = join(ROOT, CFG.skillPath);
  if (!requirePath(skill, CFG.skillPath)) return;
  let sk = '';
  try { sk = readFileSync(skill, 'utf8'); } catch { fail(CFG.skillPath, '读不出来'); return; }
  const NAME = /oversight-verifier/;
  if (!NAME.test(sk)) {
    fail(CFG.skillPath,
      '从不派发 oversight-verifier —— 主线程自己的事实类断言因此不在任何门禁的覆盖范围内。'
      + ' 定义里写得再对，没人调用等于不存在（DF-015 的原话）');
    return;
  }
  // 派发形态：名字必须与一个动词/命令出现在同一行或相邻两行内。
  // 判据刻意窄：它要挡的是「附注里提了一句」，不要求写出固定句式 ——
  // 固定句式会让措辞稍微改一下就红，而红的原因与本检查的目的无关。
  const lines = sk.split('\n');
  const idx = lines.map((l, i) => (NAME.test(l) ? i : -1)).filter((i) => i >= 0);
  const dispatching = idx.some((i) => {
    const window = [lines[i - 1] || '', lines[i], lines[i + 1] || '', lines[i + 2] || ''].join('\n');
    // 中文里 `派一个` 与 `派 一个` 都常见，`一 个` 还会被行宽折断 —— 所以判据是
    // 「派」与角色名之间只允许出现一个可选的「一个」，**不允许中间的空白成为必需**。
    return /派(?:发)?\s*(?:一个\s*)?`?oversight-verifier|oversight-verifier\s*[（(：:]/m.test(window);
  });
  if (!dispatching) {
    fail(CFG.skillPath,
      'oversight-verifier 只被提到、没被派发 —— 判据是「派 一个 oversight-verifier」这种可执行的动词形态，'
      + '不是「名字出现过」。名字在、从没派，正是 oversight-probe 当年落入的形态');
  }
}

/** 检查：**文档声明的派生深度，必须与角色定义的实际能力一致**（DF-077）。
 *
 *  ## 这条检查要防的是什么
 *
 *  `docs/spec/dispatch-contract.md §7` 曾经写着「默认深度上限 3 层（宿主默认值即为 3）」，
 *  而 12 份角色的 `tools:` 白名单里**一个派生工具都没有** —— 那份规范描述了一个
 *  这一版根本执行不了的架构。2026-11-10 的设计稿当时就判定过：
 *  「规范声称的能力在实际配置里不存在，**这比没有规范更坏**（一个读者会据此设计三层方案）」，
 *  但直到 2026-11-22 才真正改掉，中间 12 天里所有读它的人都被误导了。
 *
 *  ## 判据
 *
 *  1. 扫描 12 份角色定义的 `tools:`，收集全部工具名的并集。
 *  2. 若**没有任何**角色含派生工具（`Task` / `Agent`）→ 实际深度是 1。
 *  3. 此时，活文档里**不许**出现「深度上限 3」「递归深度 3 层」这类断言。
 *  4. 反过来：若**有**角色含派生工具，那实际深度 ≥2，也不许文档还写「深度是 1」。
 *
 *  ## 为什么用「工具名并集」而不是逐个角色判
 *
 *  深度由**最外层被派发的角色的能力**决定，而不是全部角色。但本仓的 12 个角色
 *  都可能被主线程直接派发，且它们之间没有「谁一定在上层」的约定 —— 所以
 *  「任何一个能派生」就足以让深度 ≥2。取并集是最保守（最不容易漏报）的判据。
 *
 *  ## 扫描范围
 *
 *  只查**活文档**：`CLAUDE.md` + `docs/spec/*.md`（排除 `original-design.md`，
 *  那是保留原文的历史存档，文件头已声明「冲突时以 spec/ 为准」）。
 *  不查 `docs/design/`（全是未实现的设计推演）与 `docs/research/`（会过期的过程记录）。
 */
function checkDispatchDepth() {
  const agentDir = AGENTS_DIR;
  if (!requirePath(agentDir, AGENTS_REL)) return;

  const DERIVE_TOOLS = ['Task', 'Agent'];
  const toolsUnion = new Set();
  let files = [];
  try { files = readdirSync(agentDir).filter((f) => f.endsWith('.md')); } catch { return; }
  for (const f of files) {
    let body = '';
    try { body = readFileSync(join(agentDir, f), 'utf8'); } catch { continue; }
    const m = body.match(/^tools:\s*(.+)$/m);
    if (!m) continue;
    for (const t of m[1].split(',')) toolsUnion.add(t.trim());
  }
  const canDerive = DERIVE_TOOLS.some((t) => toolsUnion.has(t));
  const actualDepth = canDerive ? 2 : 1;

  // 活文档：CLAUDE.md + docs/spec/*.md（排除历史存档）
  const liveDocs = ['CLAUDE.md'];
  try {
    for (const f of readdirSync(join(ROOT, 'docs', 'spec'))) {
      if (!f.endsWith('.md') || f === 'original-design.md') continue;
      liveDocs.push(join('docs', 'spec', f));
    }
  } catch { /* spec 目录不在就算了，别的检查会报 */ }

  // 「声称 3 层」的形态。刻意写得窄：只认明确断言，不认「宿主支持 3 层」这种
  // 说明平台能力的句子（后者含「宿主」二字，是本节要保留的正当用法）。
  const CLAIM_3 = /(?:默认)?深度上限\s*3\s*层|递归深度\s*(?:上限\s*)?3\s*层/;
  const PLATFORM_CONTEXT = /宿主|平台能力|平台默认/;

  for (const rel of liveDocs) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    let text = '';
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      if (!CLAIM_3.test(line)) return;
      if (PLATFORM_CONTEXT.test(line)) return;   // 说明平台能力，正当
      if (actualDepth === 1) {
        fail(rel,
          `第 ${i + 1} 行声称派生深度是 3 层，但 12 份角色的 tools 里没有任何派生工具`
          + `（实测工具全集：${[...toolsUnion].sort().join(', ')}）—— 实际深度是 1。`
          + ' 规范不许描述不存在的能力：一个读者会据此设计三层方案。'
          + ' 见 docs/spec/dispatch-contract.md §7');
      }
    });
  }

  // 反方向：真的能派生了，文档却还说「深度是 1」
  if (canDerive) {
    const CLAIM_1 = /深度是\s*1\s*层|深度恒为\s*1|实际深度是\s*1/;
    for (const rel of liveDocs) {
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) continue;
      let text = '';
      try { text = readFileSync(abs, 'utf8'); } catch { continue; }
      if (CLAIM_1.test(text)) {
        fail(rel, '角色里已经有派生工具（深度 ≥2），但这里仍写着「深度是 1 层」—— 文档过期了');
      }
    }
  }
}

/** 检查：**四元组字段缺失 → 失败**（P0-1 的第二项，`dispatchDepth` 之后）。
 *
 *  ## 它守的是什么
 *
 *  子 Agent 的最终返回是一个**固定字段的结构**，主线程按字段名读它。字段名少一个，
 *  下游不是「少读到一条信息」，而是**读到一个不存在的东西**：
 *
 *    · 少 `## 我产出的文件` → 产出对账拿不到自述，`UNREPORTED` 变成常态；
 *    · 少 `## 我认为的薄弱点` → 红队与锐评的「被禁输入」不存在（它们本靠**不看**保证独立，
 *      现在是**没得看**），独立性约束从设计退化成碰巧；
 *    · 少 `## 执行日志` → 主线程失去「它在哪停下的」的唯一可读线索。
 *
 *  在此之前，四元组只活在 prompt 里：`templates/dispatch.md` 写着，角色定义里抄一遍，
 *  **没有任何检查核它**。这与 DF-047 / DF-077 是同一种病：约定靠人抄，抄漏了没人发现。
 *
 *  ## 解析判据不在本文件里
 *
 *  「输出节里第一个代码围栏」的取法在 `scripts/dispatch-quartet.mjs`（`outputFenceLines()` /
 *  `quartetGaps()`）。搬走的原因：本文件是 `CLI_SCRIPTS` 的第一项，**import 它就执行
 *  全部门禁并 exit**，所以这里的判据没法被单测。而它有**两种错法不会在当前文档上暴露**
 *  （切片过早 / 围栏未闭合误判），只在有人改动文档结构时才炸 —— 那时离根因已经很远。
 *  `dispatch-quartet.test.mjs` 直接钉住那份判据的边界逻辑，本文件只负责接线。
 *
 *  ## 为什么按文件列表而不是「所有角色都要四元组」
 *
 *  四元组是 `executor` / `repair` 的返回格式，不是全部 12 个角色的：`acceptor` 交判定表、
 *  `redteam` 交反例表、`probe` 交三选一判定 —— 输出格式各自不同，而且都**不该**
 *  有「我认为的薄弱点」（那会污染独立性）。
 *
 *  **`repair` 的标题与 `executor` 不同，这是既有的、有意的差异，不是本条检查的疏忽**：
 *  它的输出是「修复后的交付物 / 修复说明 / 我认为仍然存在但本次不修的问题 / 我无法修复的部分 /
 *  我产出的文件」五节，而文件头写着「输出（四元组）」。本检查按**各文件实际声明的节**核，
 *  不强行把 `executor` 的字段名套到 `repair` 上 —— 强行统一会让「修复说明」这类字段
 *  失去它唯一的读者（验收 Agent 要看「改了什么、为什么」）。
 *  这一处「标注写四元组、内容五节」的不一致，记在 `tasks/dev-findings.md`（DF-081）。
 *
 *  ## 四个载体
 *
 *  | 文件 | 为什么它必须带回收格式 |
 *  |---|---|
 *  | `docs/spec/dispatch-contract.md` §6 | 规格本体。它说「返回是四元组」，就是给全仓下的定义 |
 *  | `templates/dispatch.md` | 每个子 Agent 都逐字收到它，它是**唯一**每轮都到场的载体 |
 *  | `.claude/agents/oversight-executor.md` | 执行 Agent 的角色定义（返回格式的权威副本） |
 *  | `.claude/agents/oversight-repair.md` | 修复 Agent（另有自己的节名，但同样必须有「我产出的文件」） |
 */
const QUARTET_CARRIERS = [
  { rel: 'docs/spec/dispatch-contract.md', sections: QUARTET_FIELDS },
  { rel: 'templates/dispatch.md', sections: QUARTET_FIELDS },
  { rel: '.claude/agents/oversight-executor.md', sections: QUARTET_FIELDS },
  {
    rel: '.claude/agents/oversight-repair.md',
    sections: [
      '## 修复后的交付物', '## 修复说明',
      '## 我认为仍然存在但本次不修的问题', '## 我无法修复的部分',
      '## 我产出的文件',
    ],
  },
];

function checkDispatchQuartet() {
  for (const { rel, sections } of QUARTET_CARRIERS) {
    const abs = join(ROOT, rel);
    // 四个载体全是本仓库的规定产物（规格 / 派发模板 / 两份角色定义）。缺文件 = 仓库坏了，
    // 与「字段缺失」是同一类：这条检查因此没有对象，必须红而不是静默跳过。
    if (!requirePath(abs, rel)) continue;
    let text = '';
    try { text = readFileSync(abs, 'utf8'); } catch (e) {
      fail(rel, `读不了文件（${e.message}）—— 四元组检查因此没有对象`);
      continue;
    }
    const got = quartetGaps(text, sections);
    if (!got.ok) {
      fail(rel, `${got.error}。四元组字段因此无法被核`);
      continue;
    }
    if (got.missing.length) {
      fail(rel, `输出格式的代码围栏里缺少 ${got.missing.length} 个字段：${got.missing.join(' / ')} —— `
        + '字段名是主线程读返回时的键，少一个就读到一个不存在的东西。'
        + '完整清单见 docs/spec/dispatch-contract.md §6');
    }
  }
}

// ── 检查 11：文档引用的路径必须存在 ────────────────────────────────────
/** 「被文档引用的文件不存在」是同一类缺陷的反复复发：`dispatch-contract.md` 让所有
 *  Agent 去读 `templates/baseline.md`，而那个文件从来没被创建过；设计稿里更是列了
 *  一堆 `scripts/org.mjs` 这样的文件名，读者无法分辨「计划中的」和「已有的」。
 *
 *  只查**活文档**（README / CLAUDE / GUIDE / 现行 spec / adr / 两份索引）。历史报告与
 *  CHANGELOG 是事实记录，里面的旧路径不该被改写，也不该被这道门拦。
 *
 *  计划中的路径必须**在同一行**标 `待建` / `未实现` / `不实现` 之类。
 *  这个豁免不是后门：它逼作者在写下路径的当场就说清「这东西还不存在」，
 *  而不是让读者自己去 `ls` 验证。 */
/** 活文档清单：路径判据 / 命令判据 / 常量判据三道都只扫这些文件。
 *
 *  ── 为什么它仍是手写清单（而不是「扫所有 `.md` 减排除」）─────────────
 *
 *  试过，会炸。实测本仓库 177 份 `.md`，把上面几道判据套到「所有 `.md`」，
 *  当场多出 **100+ 条**：`docs/research/` 93 份里 29 份有命中（单份最多 25 条，
 *  `2026-11-04-dsh-superagent-analysis.md` 分析的是**别的项目**的结构），
 *  `docs/design/` 19 份里 5 份命中（`scripts/serve.mjs`、`templates/intent.example.md`
 *  是设计稿里的**设想路径**）。那些是**事实记录**：改写它们等于篡改历史，
 *  在行尾补「待建」则等于把「当时确实这么想过」改写成「当时就说了没实现」。
 *
 *  所以缺口的真形态不是「范围太小」，是**清单靠人维护**。补法有两个：
 *    1. **可配置**：`livingDocs` 让别人的项目换掉这份清单；
 *    2. **可对账**：`livingDocsScan.include` 一开，清单漏了 scope 里任何一份 `.md`
 *       就红（`checkLivingDocsCoverage()`）。默认关，因为本仓开着当场就会红 ——
 *       现有 15 条已经漏了 `SECURITY.md` / `README-EN.md` / 8 份 `docs/spec/*`。
 *       那个缺口由 `check-config.test.mjs` 的快照守着：**新增未登记的活文档 → 测试红**。
 *       严格性留在测试里，门的输出不动（本轮硬要求是本仓行为字节级不变）。
 *
 *  一句话：参数化解决「别人项目里误报」，覆盖检查解决「新增文档不被扫」。
 *  后者不能靠扩大范围实现，只能靠「清单必须与磁盘一致」这个可判定的命题。 */
const LIVING_DOCS = CFG.livingDocs;

/** `node <脚本目录>/x.mjs --flag`。**脚本目录从配置取** —— 写死 `scripts/` 时，
 *  脚本在别处的项目里这条正则一条也匹配不到，于是「文档里的命令必须能跑」恒真。
 *
 *  两份形态是必须的，不是冗余：`matchAll` 要 `/g`，而 `String.match` 带 `/g` 时
 *  **只返回整段匹配、丢掉捕获组**（实测在这里炸过一次 `m[1] === undefined`）。
 *  同一个源码字符串派生两份，改一处两边同步。 */
const NODE_CMD_SRC = `node\\s+(${CFG.scriptsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[A-Za-z0-9_.-]+\\.mjs)([^\\n\`|)]*)`;
const NODE_CMD_RE = new RegExp(NODE_CMD_SRC, 'g');
const NODE_CMD_ONE = new RegExp(NODE_CMD_SRC);

/** 允许出现「尚不存在」路径的行标记。命中即跳过。 */
const PLANNED_MARK = /待建|未实现|不实现|实现时|计划新增|零行实现|尚未创建/;

/** `scripts/x.mjs` / `templates/x.md` / `.claude/...` 这类仓库相对路径。
 *
 *  前缀从配置拼：别人的项目脚本在 `src/` 时，写死 `scripts` 的这条正则一条都匹配
 *  不到 —— 于是「文档里的路径必须存在」对那些项目**恒真**。 */
const docPathPrefixes = [...new Set([
  CFG.scriptsDir, 'templates', 'tasks', '.claude', 'docs',
])].filter(Boolean).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const DOC_PATH_RE = new RegExp(
  `(?:^|[\\s\`(+'"|])((?:${docPathPrefixes.join('|')})/[A-Za-z0-9_./-]+\\.(?:mjs|md|json|ps1|vbs|template|yml))`,
  'g');

function checkDocReferences() {
  for (const relPath of LIVING_DOCS) {
    const p = join(ROOT, relPath);
    // 活文档清单**默认等于本产品的清单**，别人的项目里那份清单没有对象 ——
    // 所以缺文件时用 `requireProduct()`：本仓红，别人的项目记一条「本轮没跑」。
    //
    // 但**存在就照查**（这是判据真正的适用范围）：文档里引用的路径必须存在，
    // 这条对任何项目都成立。所以不是「productRepo=false 就不查」。
    if (!requireProduct(p, relPath)) continue;
    let text = '';
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      if (PLANNED_MARK.test(line)) return;
      for (const m of line.matchAll(DOC_PATH_RE)) {
        const target = m[1];
        // 模板占位符与省略号是示意，不是路径
        if (/[*<>]|\.\.\.|NNN|xxx|YYYY/.test(target)) continue;
        // 本机私有路径被 gitignore，**在干净 clone 上必然不存在**。
        // 文档里提到它们是在说「这个文件不在仓里」，不是在引用一个该存在的文件。
        // 不加这条豁免，硬门就只有「作者本机」一个环境是绿的 —— 实测干净 clone
        // 上必红 3 条，CI 从首次提交起连续失败 9 次而无人察觉。
        if (PRIVATE_PATHS.some((pp) => target === pp || target.startsWith(pp + '/'))) continue;
        if (!existsSync(join(ROOT, target))) {
          fail(relPath, `第 ${i + 1} 行引用的文件不存在：${target}`
            + '（若是有意保留的计划，请在该行标注「待建」/「未实现」）');
        }
      }
    });
  }
}

// ── 检查 12：文档里写的命令必须真的能跑 ────────────────────────────────

/** `node scripts/xxx.mjs --flag` 里的脚本可能存在、但 `--flag` 不存在。
 *  这种错误比死链更坏：读者会把它当命令敲，然后得到「未知参数」。
 *
 *  这里只做两件零成本的事：脚本文件存在、每个 `--flag` 在该脚本源码里出现过。
 *  **不执行命令**——`scan-sessions.mjs --help` 会真的开扫（实测 78 秒），
 *  `verify-bugfix-negatives.mjs` 会改写源码。把「跑一遍」放进硬门是灾难。 */
function checkDocCommands() {
  for (const relPath of LIVING_DOCS) {
    const p = join(ROOT, relPath);
    // 活文档清单默认等于**本产品的**清单；别人的项目里那份清单没有对象（DF-051）。
    // 所以缺文件用 `requireProduct()`，但**存在就照查** —— 判据本身对任何项目都成立。
    if (!requireProduct(p, relPath)) continue;
    let text = '';
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      if (PLANNED_MARK.test(line)) return;
      for (const m of line.matchAll(NODE_CMD_RE)) {
        const script = m[1];
        if (!existsSync(join(ROOT, script))) {
          fail(relPath, `第 ${i + 1} 行命令引用了不存在的脚本：${script}`);
          continue;
        }
        let src = '';
        try { src = readFileSync(join(ROOT, script), 'utf8'); } catch { continue; }
        for (const f of new Set([...m[2].matchAll(/(--[a-z][a-z0-9-]*)/g)].map((x) => x[1]))) {
          if (!src.includes(f)) {
            fail(relPath, `第 ${i + 1} 行用了 ${script} 不支持的参数 ${f}`);
          }
        }
      }
    });
  }
}

// ── 检查 13：文档写死的常量值必须与源码一致 ────────────────────────────

/** 这是 `checkTestCount()` 的同类推广：数字只要靠手写就会漂。
 *
 *  只查**显式对照**形态 `` `MAX_SUBAGENTS = 100` ``——那种写法是在断言
 *  「这个常量等于这个值」，一旦源码改了它就是一句假话。精确、零误报。
 *
 *  **不查散文里的数字**（「上限 100」）：那种句子要判断它指的是哪个常量，
 *  语义歧义导致的误报会让人把整道门关掉，得不偿失。 */
function checkDocConstants() {
  const consts = new Map();
  const dir = SCRIPTS_DIR;
  if (!requirePath(dir, SCRIPTS_REL)) return;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs') && !x.endsWith('.test.mjs'))) {
    let t = '';
    try { t = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    for (const m of t.matchAll(/^const ([A-Z][A-Z0-9_]{2,}) = (\d[\d_]*)(?:;|\s*\/\/|\s*$)/gm)) {
      consts.set(m[1], { value: Number(m[2].replace(/_/g, '')), file: f });
    }
  }
  if (!consts.size) return;

  for (const relPath of LIVING_DOCS) {
    const p = join(ROOT, relPath);
    // 活文档清单默认等于**本产品的**清单；别人的项目里那份清单没有对象（DF-051）。
    // 所以缺文件用 `requireProduct()`，但**存在就照查** —— 判据本身对任何项目都成立。
    if (!requireProduct(p, relPath)) continue;
    let text = '';
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/`([A-Z][A-Z0-9_]{2,}) = (\d[\d_]*)`/g)) {
        const c = consts.get(m[1]);
        if (!c) continue;
        const claimed = Number(m[2].replace(/_/g, ''));
        if (claimed !== c.value) {
          fail(relPath, `第 ${i + 1} 行写 ${m[1]} = ${claimed}，`
            + `而 ${SCRIPTS_REL}/${c.file} 里是 ${c.value}`);
        }
      }
    });
  }
}

// ── 检查 14：研究索引必须覆盖每一份报告 ────────────────────────────────

/** 与 `checkDesignIndex()` 同形，理由也一样：62 份研究报告里只要有几份没进索引，
 *  它们就等于不存在——没人会逐份点开一个没有目录的文件夹。
 *
 *  另外强制索引保留**状态标记**（有效 / 部分失效 / 已推翻 / 未验证）。
 *  一份没有状态的研究报告不是结论，是原材料；索引若退化成纯文件列表，
 *  「已推翻的结论仍被引用」这件事就会重新发生。 */
function checkResearchIndex() {
  const dir = join(ROOT, 'docs', 'research');
  // research/ 是本产品自身的产物（62 份报告 + 索引）。别人的项目里没有它是正常的 ——
  // 用 requireProduct()（DF-051）。存在就照查：索引与状态标记的判据照样适用。
  if (!requireProduct(dir, 'docs/research')) return;
  const index = join(dir, 'README.md');
  if (!requireProduct(index, 'docs/research/README.md')) return;
  let idx = '';
  try { idx = readFileSync(index, 'utf8'); } catch { /* ignore */ }
  for (const marker of ['有效', '已推翻', '未验证']) {
    if (!idx.includes(marker)) {
      fail('docs/research/README.md', `索引缺少状态标记「${marker}」——没有状态的研究报告等于没有结论`);
    }
  }
  const docs = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  const missing = docs.filter((f) => !idx.includes(f));
  if (missing.length) {
    fail('docs/research/README.md', `这些报告没有登记（新增报告必须写明状态与依据）：${missing.join(', ')}`);
  }
}

// ── 检查 15：能力清单里的每条命令必须可执行 ────────────────────────────

/** README 说「能做什么」是靠人相信的。`docs/CAPABILITIES.md` 把每条能力绑到
 *  **一条可运行的命令**上，这道门只保证那些命令的脚本与参数真实存在。
 *
 *  它不能证明「命令输出能支持这句声称」——那需要人读。但它能挡住最坏的一种：
 *  某条能力对应的脚本已经被删/改名，而 README 还在承诺。
 *
 *  同时要求 README 指向这份清单。理由同 design 索引：没有入口的清单等于没有。
 *
 *  `CAPABILITIES.md` 的落点是**固定的** `docs/CAPABILITIES.md`：它是本仓库的能力
 *  清单，不是别人的。别人的项目里它不存在时这条会红 —— 那是「真正该报的」之一：
 *  框架装进项目之后，「能做什么」需要一个可核对的清单。不想要就
 *  `disabledChecks` 里关掉，开关会打印一行提示。
 *
 *  命令里的脚本目录从配置取（脚本在 `src/` 的项目同样成立）。 */
const CAP_CMD_ROW_RE = new RegExp(
  '`(node (' + CFG.scriptsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/)[A-Za-z0-9_.-]+\\.mjs[^`]*)`');
function checkCapabilities() {
  const doc = join(ROOT, 'docs', 'CAPABILITIES.md');
  // 能力清单是本产品自身的产物：别人的项目没有它是正常的（DF-051）。
  // 上面那段注释已论证过「不想要就 disabledChecks 关掉」，域位让它**默认就对**，
  // 不需要用户知道 17 个内部名字中的这一个。
  if (!requireProduct(doc, 'docs/CAPABILITIES.md')) return;
  let text = '';
  try { text = readFileSync(doc, 'utf8'); } catch { return; }

  let rows = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cmd = line.match(CAP_CMD_ROW_RE);
    if (!cmd) continue;
    rows++;
    const m = cmd[1].match(NODE_CMD_ONE);
    if (!m) continue;
    if (!existsSync(join(ROOT, m[1]))) {
      fail('docs/CAPABILITIES.md', `能力清单引用了不存在的脚本：${m[1]}`);
      continue;
    }
    let src = '';
    try { src = readFileSync(join(ROOT, m[1]), 'utf8'); } catch { continue; }
    for (const f of new Set([...m[2].matchAll(/(--[a-z][a-z0-9-]*)/g)].map((x) => x[1]))) {
      if (!src.includes(f)) fail('docs/CAPABILITIES.md', `${m[1]} 不支持参数 ${f}`);
    }
  }
  if (!rows) {
    fail('docs/CAPABILITIES.md', '能力清单里没有任何「能力 → 命令」行，这份文件退化成了一篇文章');
  }

  // 入口必须可达
  const readme = join(ROOT, 'README.md');
  if (existsSync(readme)) {
    let r = '';
    try { r = readFileSync(readme, 'utf8'); } catch { /* ignore */ }
    if (!r.includes('docs/CAPABILITIES.md')) {
      fail('README.md', '没有指向 docs/CAPABILITIES.md —— 读者无法核对「能做什么」');
    }
  }
}

// ── 检查 16：活文档清单必须与磁盘一致（可开可关）────────────────────────

/** 手写清单的失效方式是结构性的：**新增一份活文档，它不在名单里，而门照样绿**。
 *  `check-structure.mjs` 自己在 `checkAbsolutePaths()` / `checkLinks()` 两处都用
 *  40 行论证过这件事，而 `LIVING_DOCS` 自己就是一张手写清单 —— 矛盾是真实的。
 *
 *  为什么不能改成「扫所有 `.md` 减排除」：见 `LIVING_DOCS` 上方的实测（100+ 条误报，
 *  且那些是历史记录，不该被改写）。
 *
 *  能做的只有一条可判定的命题：**scope 里出现的每一份 `.md` 都必须在清单里**。
 *  它不解决「range 太小」，但它把「清单漂了」从无人知晓变成一行红。
 *
 *  默认 `include: []` = 不开。本仓开着当场就会红（现有 15 条漏了 `SECURITY.md` 等），
 *  而本轮硬要求是本仓行为字节级不变。缺口的规模由 `check-config.test.mjs` 钉住。 */
function checkLivingDocsCoverage() {
  const scope = CFG.livingDocsScan || { include: [], exclude: [] };
  if (!Array.isArray(scope.include) || !scope.include.length) return;
  const gap = livingDocsGap(ROOT, scope, LIVING_DOCS);
  for (const f of gap.unregistered) {
    fail(f, '在 livingDocsScan 的范围内，但不在 livingDocs 清单里 —— '
      + '这道门不会扫它。要么登记进清单（`.untildone/checks.json` 的 livingDocs），'
      + '要么把该目录排除（livingDocsScan.exclude）');
  }
  for (const f of gap.missing) {
    fail(f, 'livingDocs 清单里有这份文件，磁盘上却没有 —— 清单已漂；删掉该项或补上文件');
  }
}

/** 元检查：**CHECKS 表里的每一条都必须真的被调用**（DF-047）。
 *
 *  ## 它守的是什么
 *
 *  决定性实验（2026-11-21）：把 `checkChangelog()` 与 `checkLedger()` 两个 dispatch
 *  调用从运行块里删掉，硬门照样 `✓ 结构检查全部通过` + exit 0，1874 条回归测试全过。
 *  **没有任何机制发现这两条检查被删了。**
 *
 *  这是本仓库最稳定的失效模式的一个特例：`CHECKS` 是一张**手写清单**，而「清单上
 *  有它」与「它真的跑了」是两件事。手写清单的失效方式是结构性的 —— 这一条不是靠
 *  「小心点」，而是靠一次机械比对把它变成红。
 *
 *  ## 为什么不直接断言「文本里出现 fn();」
 *
 *  那种判据会被注释、被同名字符串、被 `// checkLedger();` 命中 —— 本文件已经吃过
 *  这类判据的亏（`checkStopHookKillSwitch()` 的头注释里记着：`src.includes('X(')`
 *  连**定义行**自己都会命中）。
 *
 *  这里改为**运行时记账**：运行循环每调用一条就往 `ran` 里记一项，跑完与 `CHECKS`
 *  逐个对账。删掉一条 dispatch，它就不在 `ran` 里，这条立刻红。
 *  记账是运行期的观测，不是文本猜测 —— 它无法被注释骗过。
 *
 *  @param {string[]} ran 本轮真实执行过的检查名
 *  @param {string[]} [notApplicable] 因适用域而跳过的检查名（`productRepo=false` 时的产品规矩）
 *  @returns {void} */
function checkDispatchCoverage(ran, notApplicable = []) {
  const declared = CHECKS.map(([name]) => name);
  const ranSet = new Set(ran);
  const naSet = new Set(notApplicable);

  // ## 为什么必须锚在 `CHECK_NAMES` 上，而不是只对 `CHECKS` 自己
  //
  // 第一版只做 `CHECKS` ↔ `ran` 的比对，负向测试立刻暴露了它的漏洞：
  // **删掉 `CHECKS` 表里的一整行**（`['ledger', checkLedger],`）时，`declared` 也
  // 跟着少一项，两边仍然一致 —— 门照绿。那正是决定性实验的原样：
  // 拿掉一条检查，没有任何机制发现。
  //
  // `CHECK_NAMES` 在 `scripts/check-config.mjs` 里，是**配置的对外契约**
  // （`disabledChecks` 的合法取值）。它是独立的一份真源，删 `CHECKS` 的行不会
  // 同时删它。两份对不上 = 有人绕过了一次登记。这才是可判定的锚点。
  const contract = CHECK_NAMES;
  const contractSet = new Set(contract);

  const droppedFromTable = contract.filter((n) => !declared.includes(n));
  if (droppedFromTable.length) {
    fail('scripts/check-structure.mjs',
      `CHECK_NAMES 里有 ${droppedFromTable.length} 条检查在 CHECKS 表里找不到：`
      + `${droppedFromTable.join(', ')} —— 它们既不会运行，也无法被 disabledChecks 表达。`
      + `删掉一条检查必须同时改两处，只改一处会红在这里。`);
  }
  const unknownInTable = declared.filter((n) => !contractSet.has(n));
  if (unknownInTable.length) {
    fail('scripts/check-structure.mjs',
      `CHECKS 表里有 ${unknownInTable.length} 条不在 CHECK_NAMES 里：${unknownInTable.join(', ')} ——`
      + '用户在配置里写不出它的名字，等于无法关闭');
  }

  // 关掉的检查是**声明过的跳过**，不算「漏跑」—— 但它已经在别处被 warning 列出。
  const dis = new Set(CFG.disabledChecks || []);
  const missing = declared.filter((n) => !ranSet.has(n) && !dis.has(n) && !naSet.has(n));
  if (missing.length) {
    fail('scripts/check-structure.mjs',
      `CHECKS 表里有 ${missing.length} 条检查本轮从未被调用：${missing.join(', ')} —— `
      + '门会把它当成「通过」。这正是 DF-047 的决定性实验：删掉 dispatch 后门照绿。');
  }

  // ## 每一条检查都必须声明**适用域**（DF-051 的机制面）
  //
  // 域位只在「每条检查都登记了域」时才成立。漏登记一条的表现是：`domainOf()` 返回
  // null，运行循环保守地把它当 universal 跑 —— 于是它在别人的项目里**照旧报红**，
  // 而 DF-051 会以「新加的一条规矩」的形式悄悄复发。这条比对把它变成一次当场红。
  const noDomain = declared.filter((n) => domainOf(n) === null);
  if (noDomain.length) {
    fail('scripts/check-structure.mjs',
      `CHECKS 表里有 ${noDomain.length} 条检查没有声明适用域（CHECK_DOMAINS）：${noDomain.join(', ')} —— `
      + '未声明 = 被当成「任何项目都该成立」，于是本产品自己的规矩会在别人的项目里报红（DF-051）');
  }

  // 反向：跑了但登记表里没有 —— 说明有人加了调用却没登记，它不会被 disabledChecks 关掉，
  // 也不会出现在「N 条检查」的计数里。同样是一种「不可见」。
  const unregistered = ran.filter((n) => !declared.includes(n));
  if (unregistered.length) {
    fail('scripts/check-structure.mjs',
      `运行了但不在 CHECKS 表里：${unregistered.join(', ')} —— 它无法被配置关闭，也不计入总数`);
  }

  // ## 「N 项检查」这个数字必须自己核（DF-053 / DF-078）
  //
  // `README.md` 里写了两次「N 项检查」。实测它长期写的是 `23`，而 `CHECK_NAMES`
  // 当时是 25 —— **没有任何检查在核这个数**，所以它漂了两轮没人发现。
  // 这个仓库有 `checkTestCount()` 专门防「文档里的测试数漂了」，
  // 却没有对应的东西防「文档里的检查数漂了」，而后者是本仓最常被引用的自证。
  //
  // 判据：活文档里凡写「N 项检查」，N 必须等于 `CHECK_NAMES.length`。
  const LIVE = ['README.md', 'CLAUDE.md', 'docs/GUIDE.md', 'docs/CAPABILITIES.md'];
  const CLAIM = /(\d+)\s*(?:项|条)检查/g;
  for (const rel of LIVE) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    let text = '';
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(CLAIM)) {
        const n = Number(m[1]);
        if (n !== contract.length) {
          fail(rel, `第 ${i + 1} 行写「${m[1]} 项检查」，实际 ${contract.length} 条（CHECK_NAMES）—— `
            + '这个数字没有任何别的机制核它，漂了就一直是错的');
        }
      }
    });
  }
}

// ── 运行 ──────────────────────────────────────────────────────────────

/** 检查名 → 实现。**名字是配置里 `disabledChecks` 的取值**，所以它是一份对外契约：
 *  改名等于让用户的配置静默失效（`validateChecks()` 会报未知名，但那是在他们升级之后）。 */
const CHECKS = [
  ['absolutePaths', checkAbsolutePaths],
  ['privatePaths', checkPrivatePaths],
  ['gitignoreSanity', checkGitignoreSanity],
  ['agents', checkAgents],
  ['emptyDirs', () => checkEmptyDirs()],
  ['capabilityDisclosure', checkCapabilityDisclosure],
  ['testCount', checkTestCount],
  ['executionClaims', checkNoExecutionClaims],
  ['syntax', checkSyntax],
  ['importable', checkImportable],
  ['unregisteredExports', checkUnregisteredExports],
  ['links', checkLinks],
  ['changelog', checkChangelog],
  ['stopHookKillSwitch', checkStopHookKillSwitch],
  ['ledger', checkLedger],
  ['launcherPlacement', checkLauncherPlacement],
  ['inboxWiring', checkInboxWiring],
  ['promptWiring', checkPromptWiring],
  ['evidenceTaxonomy', checkEvidenceTaxonomy],
  ['designIndex', checkDesignIndex],
  ['agentReachability', checkAgentReachability],
  ['hubVerifier', checkHubVerifier],
  ['dispatchDepth', checkDispatchDepth],
  ['dispatchQuartet', checkDispatchQuartet],
  ['docReferences', checkDocReferences],
  ['docCommands', checkDocCommands],
  ['docConstants', checkDocConstants],
  ['researchIndex', checkResearchIndex],
  ['capabilities', checkCapabilities],
  ['livingDocsCoverage', checkLivingDocsCoverage],
];

console.log('check-structure · 仓库结构硬门\n');

const disabled = new Set(CFG.disabledChecks || []);
/** 本轮**真的调用过**的检查名。元检查拿它与 `CHECKS` 表对账 —— 见
 *  `checkDispatchCoverage()` 的头注释（DF-047）。 */
const ran = [];
/** 因为**适用域**（`productRepo=false`）而没跑的产品规矩。与 `disabledChecks`
 *  分开记：那是用户逐条关掉的，这是整整一族因为「这不是本产品的仓库」而不适用。
 *  两者都要打印，但说的事情不同 —— 混成一份会让「17 条被关掉」看起来像用户的决定。 */
const notApplicable = [];
for (const [name, fn] of CHECKS) {
  if (disabled.has(name)) continue;
  const domain = domainOf(name);
  // **未登记的检查名 = 直接红**（在 `checkDispatchCoverage()` 里报），这里保守地
  // 当成 universal 执行 —— 「不知道属于哪一族」时宁可多查，不可静默不查。
  if (PRODUCT_REPO === false && domain === 'product') {
    notApplicable.push(name);
    continue;
  }
  CURRENT_CHECK = name;
  fn();
  // **记账在调用之后**。写在前面的话，「登记了但被 `continue` 掉」也会被记成跑过 ——
  // 那正是这条元检查要抓的形态。顺序本身就是判据的一部分。
  ran.push(name);
}
CURRENT_CHECK = '(done)';
// 元检查必须**最后跑**：它要对着完整的 `ran` 对账。
checkDispatchCoverage(ran, notApplicable);

// 关掉的检查必须**每次都出现在屏幕上**：静默关掉等于把「检查通过」偷偷换成「没检查」，
// 而这句话是这道门唯一的价值。提示不阻塞（这是用户的合法选择），但不可能不被看见。
for (const name of disabled) {
  warn(CONFIG_REL, `检查 "${name}" 已被 disabledChecks 关闭 —— 本轮没有执行它`);
}

// ── 输出 ────────────────────────────────────────────────────────────
//
// **「没跑」与「通过」必须在输出上不同形**（DF-047）。旧版只有两种结尾：
// `✓ 结构检查全部通过` 或 `✗ N 项违规`。而「某条检查因为文件不存在而提前
// `return`」两种都不是 —— 它落进第一种，读者无从分辨。
//
// 现在 `✓` 那一行走的是**核实过覆盖面之后**的措辞：跑了几条、其中几条没跑完，
// 都印在同一行里。`✓ 全部通过` 只在「24 条全跑、且没有一条报未跑」时出现。
const skippedUniq = [...new Map(skipped.map((s) => [s.check + '\u0000' + s.why, s])).values()];
const covered = ran.length;
const notRunChecks = new Set([...skippedUniq.map((s) => s.check), ...productMissing.keys()]);

if (violations.length) {
  console.log(`✗ ${violations.length} 项违规：\n`);
  for (const v of violations) console.log(`  [${v.file}] ${v.msg}`);
} else if (skippedUniq.length || notApplicable.length || productMissing.size) {
  // 有未跑项时**不许**印「全部通过」—— 那正是本缺陷的原始形态。
  const parts = [];
  if (skippedUniq.length) parts.push(`${notRunChecks.size} 条只跑了一部分：另有 ${skippedUniq.length} 处因目标不存在而未覆盖`);
  if (productMissing.size) parts.push(`${productMissing.size} 条因本产品的产物不在盘上而未覆盖`);
  if (notApplicable.length) parts.push(`${notApplicable.length} 条本产品自身的规矩不适用（productRepo=false）`);
  console.log(`✓ 已执行的 ${covered} 条检查全部通过（${parts.join('；')}）`);
} else {
  console.log(`✓ 结构检查全部通过（${covered} 条全部执行完毕，无跳过）`);
}

if (skippedUniq.length) {
  console.log(`\n— ${skippedUniq.length} 处未跑（不阻塞，但**不计入「通过」**）：`);
  for (const s of skippedUniq) console.log(`  [${s.check}] ${s.why}`);
}

// 本产品自身的产物不存在：按检查聚合成**一行**。
//
// 逐份打印会让 `livingDocs` 一份清单变成 16 行，于是「3 条违规 + 60 行未跑」的屏幕
// 看起来像这道门在指责对方 —— 那正是 DF-051 要消灭的观感。聚合之后它说的是另一件
// 事：「这条检查的覆盖面比它的名字窄」，一句就够。
if (productMissing.size) {
  const parts = [...productMissing.entries()]
    .map(([name, n]) => `${name}（${n} 处）`).join('、');
  console.log(`\n— ${productMissing.size} 条检查的覆盖面比名字窄（本产品自身的产物不在盘上）：`);
  console.log(`  ${parts}`);
}

// 适用域必须可见（DF-051）：「本产品的规矩全部通过」与「本产品的规矩一条都没跑」
// 在屏幕上必须是两句不同的话。`productRepo=false` 是别人的项目的正常形态，
// 不是错误 —— 但它决定了这一轮**覆盖了什么**，所以不静默。
if (notApplicable.length) {
  console.log(`\n· 本产品自身的规矩本轮不适用（${notApplicable.length} 条，productRepo=false）：`);
  console.log(`  ${notApplicable.join(', ')}`);
  console.log('  这些是「本仓库怎么管自己」的规矩，别人的项目没有对象。'
    + `要在本产品自己的仓库里跑它们，在 ${CONFIG_REL} 写 "productRepo": true。`);
}

if (warnings.length) {
  console.log(`\n⚠ ${warnings.length} 项提示（不阻塞）：`);
  for (const w of warnings) console.log(`  [${w.file}] ${w.msg}`);
}

process.exit(violations.length ? 1 : 0);
