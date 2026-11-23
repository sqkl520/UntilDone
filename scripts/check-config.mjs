#!/usr/bin/env node
/**
 * check-config.mjs — 结构硬门「哪些算可发布 / 私有 / 活文档 / 角色目录」的唯一读取处。
 *
 * ## 为什么要有这个文件
 *
 * 红队实测（`%TEMP%` 下一个 4 文件的真项目）跑 `check-structure.mjs` 报出 10 条违规，
 * 其中 8 条与那个项目毫无关系 —— 它们不是「判据错了」，是**判据把本仓库的形状
 * 当成了常量**：`tasks/runs` 是本仓的台账落点，`.claude/agents` 是本仓的角色目录，
 * `scripts/` 是本仓的脚本目录。
 *
 * 修法有两条路，选的是第二条：
 *
 *   1. 逐个判据加 `if (existsSync(...))` 守卫 —— 失效方式是**静默**：别人的项目里
 *      目录名不同，门照样绿，而绿的意思从「检查通过」变成「没检查」。
 *   2. 把形状提成配置，**默认值等于本仓库现状** —— 本仓不写配置文件也逐字节不变，
 *      别人写一份就换掉形状；写错了（拼错键、类型不对）直接报错，不静默回落。
 *
 * ## 默认值必须等于本仓现状
 *
 * 这是本文件唯一的硬要求。第十条的「本仓自检」测试直接把
 * `.untildone/checks.json` 与 `DEFAULTS` 逐字对账：改了这里的默认值却没改
 * 仓库自己那份配置 → 测试红。反过来，仓库那份配置若被谁改歪了（比如把
 * `scriptsDir` 改成 `src`），同一测试也红 —— 那是「参数化了但本仓行为变了」的
 * 唯一可检测形态，否则它只会在某次跑门时以「违规数从 0 变成 3」出现。
 *
 * ## 为什么不放进 `overwatch.config.json`
 *
 * 那份配置的键白名单在 `question-audit.mjs` 的 `validateConfig()`，未知键 = 错误。
 * 往那里加一个顶层键，代价是改一份**运行期**校验器（它的失败会让 launch 的
 * roster 与 question-audit 的判据全部停摆），只为放一个**门禁期**的形状声明。
 * 两个消费者、两个失败面，分开更安全。落点用 `.untildone/` 是既有的框架命名空间
 * （`project-root.mjs` 的 `DEFAULT_RUNS_REL`）。
 *
 * ## 零依赖，只读盘。
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';

/** 配置落点（相对项目根）。**固定**，不提供「往别处找」的第二条路 ——
 *  两份配置同时存在时，哪份生效会变成不可回答的问题。 */
export const CONFIG_REL = '.untildone/checks.json';

/** 显式指定配置文件的唯一覆盖入口（`--config <path>` 用的是它）。
 *  环境变量留给 CI：命令行参数在 npm script 里常常被吞掉。 */
export const CONFIG_ENV = 'UNTILDONE_CHECKS';

/** 默认值 = **本仓库现状**，逐字。改这里就必须同步改 `.untildone/checks.json`，
 *  否则 `check-config.test.mjs` 的「本仓自检」会红。 */
export const DEFAULTS = Object.freeze({
  /** 可发布区：出现本机绝对路径即为违规。只在「目录存在」时扫。 */
  publishedDirs: ['docs', 'templates', 'rules', 'scripts', 'spec-adr'],
  /** 私有区：允许出现本机路径，但必须被 `.gitignore` 排除。 */
  privatePaths: ['tasks/runs', 'local', '.claude/settings.local.json', 'CLAUDE.local.md'],
  /** 运行台账的落点。**必须在 `privatePaths` 里**（下面的校验会核这条），
   *  否则「台账被 gitignore 排除」这条检查会看着另一个目录说绿。 */
  runsDir: 'tasks/runs',
  /** `.gitignore` 里出现这些整目录规则 = 把产品本体排除了，`git add -A` 会静默不加。 */
  gitignoreFatal: ['.claude', 'rules', 'docs', 'templates', 'scripts', 'tasks'],
  /** 活文档：会被「引用路径必须存在 / 命令必须能跑 / 常量必须对得上」三道判据扫的文件。
   *  手写清单 + 下面的 `livingDocsScan` 覆盖检查，理由见 `checkLivingDocsCoverage()`。 */
  livingDocs: [
    'README.md',
    'CLAUDE.md',
    'docs/README.md',
    'docs/GUIDE.md',
    'docs/CAPABILITIES.md',
    'docs/design/README.md',
    'docs/research/README.md',
    'docs/spec/state-model.md',
    'docs/spec/dispatch-contract.md',
    'docs/spec/evidence-discipline.md',
    'docs/spec/relay-protocol.md',
    'docs/spec/output-format.md',
    'docs/spec/success-metrics.md',
    'docs/spec/tui-visual.md',
    'docs/adr/0001-config-only.md',
    'docs/adr/0002-honest-degradation.md',
  ],
  /** 角色定义目录（`.md` 一份一个角色）。 */
  agentsDir: '.claude/agents',
  /** 调度入口（SKILL.md）的落点。**不在派单列的 6 个常量里**，但同属一族：
   *  `checkInboxWiring` / `checkPromptWiring` / `checkAgentReachability` 三处都拿它
   *  判断「调度入口有没有提到某个脚本」。写死成 `.claude/skills/oversight/SKILL.md`
   *  时，别人的项目里那份文件不存在 → 三条检查各自静默 `return` → 门报绿而没查。
   *  这个失效方式（静默通过）比报红更坏，所以一并提成配置。 */
  skillPath: '.claude/skills/oversight/SKILL.md',
  /** 脚本目录。**不带尾斜杠**，拼路径用 `join()`。 */
  scriptsDir: 'scripts',
  /** 活文档覆盖检查的范围。`include: []` = **不开**（默认）。
   *
   *  为什么默认关：开了它本仓**当场就会红** —— 现有 15 条手写清单漏了
   *  `SECURITY.md` / `SECURITY-EN.md` / `README-EN.md` / `CONTRIBUTING*.md` 与
   *  8 份 `docs/spec/*.md`、`docs/adr/0003`、`0004`。那是真缺口，但修它要改文档，
   *  而本次改动的硬要求是「本仓行为字节级不变」。缺口的规模被
   *  `check-config.test.mjs` 的快照钉住了：**新增任何一份未登记的活文档，
   *  `node --test` 就会红** —— 严格性留在测试里，门的输出不动。 */
  livingDocsScan: { include: [], exclude: [] },
  /** 显式关闭的检查（按 `check-structure.mjs` 里 RUNS 的名字）。
   *
   *  存在理由：这 24 条里有几条是**本产品自己的规矩**（README 必须声明「不能自动接力」、
   *  必须有启动器模板、能力清单必须是 `node scripts/*.mjs` 行）。别人的项目里它们红
   *  是对的判据、错的适用范围。给了开关，但**每条被关掉的检查都会打印一行提示** ——
   *  静默关掉等于把「检查通过」偷偷改成「没检查」。 */
  disabledChecks: [],
});

/** 所有检查的名字。与 `check-structure.mjs` 的 RUNS 表一一对应；那边的未知名字会报错。 */
export const CHECK_NAMES = Object.freeze([
  'absolutePaths', 'privatePaths', 'gitignoreSanity', 'agents', 'emptyDirs',
  'capabilityDisclosure', 'testCount', 'syntax', 'importable', 'unregisteredExports',
  'links', 'changelog', 'stopHookKillSwitch', 'ledger', 'launcherPlacement',
  'inboxWiring', 'promptWiring', 'evidenceTaxonomy', 'designIndex', 'agentReachability', 'dispatchDepth',
  'dispatchQuartet',
  'docReferences', 'docCommands', 'docConstants', 'researchIndex', 'capabilities',
  'livingDocsCoverage',
]);

/** 统一正斜杠、去掉 `./` 前缀与尾部斜杠。空串保持空串（由校验报错）。 */
export function normRel(p) {
  return String(p == null ? '' : p)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/** 路径必须**是相对项目根的**：绝对路径、盘符、`..` 一律不接受。
 *
 *  为什么不接受绝对路径：这些键的语义是「项目里的哪个位置」。允许绝对路径之后，
 *  同一份配置在别人的机器上指向别处 —— 而那正是本文件要消除的东西。 */
function pathError(v) {
  if (typeof v !== 'string') return '必须是字符串';
  if (!v.trim()) return '不能是空串';
  if (isAbsolute(v) || /^[A-Za-z]:/.test(v)) return '不能是绝对路径（要相对项目根）';
  if (normRel(v).split('/').includes('..')) return '不能含 ".."（要相对项目根）';
  return null;
}

const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** 校验一份配置对象。**非法即报错，绝不静默回落**。
 *
 *  这条规矩是本仓库付过学费的（`question-audit.mjs` 的 `validateConfig()` 头注释）：
 *  `scan-sessions.mjs --days abc` 曾经静默回落成 7 天。配置比命令行参数更危险 ——
 *  它不出现在命令历史里，没人会重新看一遍。所以：
 *    · 未知键 = 错误（拼错 `scriptsPrefix` 不会被当成默认值忽略）；
 *    · 类型不对 = 错误（不做 `String(x) || 默认` 那类隐式转换）；
 *    · 语义矛盾 = 错误（`runsDir` 不在 `privatePaths` 里）。
 *
 *  @returns {{ok:boolean, config:object|null, errors:Array<{path:string,msg:string}>}}
 */
export function validateChecks(raw) {
  const errors = [];
  const err = (path, msg) => errors.push({ path, msg });

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    err('', '配置根必须是 JSON 对象');
    return { ok: false, config: null, errors };
  }

  const TOP = new Set(['$schema', ...Object.keys(DEFAULTS)]);
  for (const k of Object.keys(raw)) {
    if (!TOP.has(k)) err(k, `未知的键 "${k}"（拼错了？允许：${[...TOP].join(' / ')}）`);
  }

  const out = {};

  for (const key of ['publishedDirs', 'privatePaths', 'gitignoreFatal', 'livingDocs', 'disabledChecks']) {
    const v = raw[key] === undefined ? [...DEFAULTS[key]] : raw[key];
    if (!isStrArray(v)) { err(key, '必须是字符串数组'); continue; }
    for (const item of v) {
      const e = pathError(item);
      if (e) { err(key, `"${item}" ${e}`); break; }
    }
    if (key === 'disabledChecks') {
      for (const name of v) {
        if (!CHECK_NAMES.includes(name)) {
          err(key, `未知的检查名 "${name}" —— 拼错的名字不会关掉任何东西，只会让「已关闭」看起来生效`);
        }
      }
    }
    out[key] = v.map(normRel).map((s) => (s === '' ? String(s) : s));
    // disabledChecks 是检查名不是路径，不能被 normRel 改形（避免 future 名字里带 `/` 时静默变样）
    if (key === 'disabledChecks') out[key] = [...v];
  }

  for (const key of ['agentsDir', 'scriptsDir', 'runsDir', 'skillPath']) {
    const v = raw[key] === undefined ? DEFAULTS[key] : raw[key];
    const e = pathError(v);
    if (e) { err(key, e); continue; }
    out[key] = normRel(v);
  }

  // 台账落点必须在私有区里：两张表指向不同目录时，「台账被 gitignore 排除」这条检查
  // 会对着另一个目录报绿。默认值满足这一条（`tasks/runs` ∈ `privatePaths`）。
  if (out.runsDir && Array.isArray(out.privatePaths)) {
    const covered = out.privatePaths.some((pp) => out.runsDir === pp || out.runsDir.startsWith(pp + '/'));
    if (!covered) {
      err('runsDir', `"${out.runsDir}" 不在 privatePaths 里 —— 台账会被当成可发布内容`);
    }
  }

  const scan = raw.livingDocsScan === undefined ? DEFAULTS.livingDocsScan : raw.livingDocsScan;
  if (scan === null || typeof scan !== 'object' || Array.isArray(scan)) {
    err('livingDocsScan', '必须是对象 { include, exclude }');
  } else {
    for (const k of Object.keys(scan)) {
      if (!['include', 'exclude'].includes(k)) err(`livingDocsScan.${k}`, `未知的键 "${k}"（允许：include / exclude）`);
    }
    const norm = {};
    for (const k of ['include', 'exclude']) {
      const v = scan[k] === undefined ? [] : scan[k];
      if (!isStrArray(v)) { err(`livingDocsScan.${k}`, '必须是字符串数组'); continue; }
      for (const item of v) {
        const e = pathError(item.replace(/\*+$/, '')) ;
        // 允许通配符：只把 `*` 剥掉再做绝对/`..` 判断
        if (e) { err(`livingDocsScan.${k}`, `"${item}" ${e}`); break; }
      }
      norm[k] = v.map(normRel);
    }
    out.livingDocsScan = norm;
  }

  return { ok: errors.length === 0, config: errors.length ? null : out, errors };
}

/**
 * 读配置。**找不到就用默认值**（这是「本仓不写配置也逐字节不变」的实现点）。
 *
 * 显式指定了路径却读不到，则**报错**而不是回落默认值：说了要用那份，用不到就该停。
 * 两种情况必须可区分 —— 否则「我写了配置但没生效」与「我没写配置」在屏幕上是同一个样子。
 *
 * @param {string} root 项目根（`check-structure.mjs` 传 `process.cwd()`）
 * @param {{configPath?:string|null, env?:object}} [opts]
 * @returns {{config:object, path:string|null, errors:Array<{path:string,msg:string}>,
 *            source:'file'|'defaults'}}
 */
export function loadChecks(root, { configPath = null, env = process.env } = {}) {
  const explicit = configPath || (env && env[CONFIG_ENV]) || null;
  const p = explicit ? resolve(String(explicit)) : join(String(root || '.'), CONFIG_REL);

  if (!existsSync(p)) {
    if (explicit) {
      return {
        config: DEFAULTS,
        path: p,
        errors: [{ path: 'config', msg: `指定的配置文件不存在：${explicit}` }],
        source: 'defaults',
      };
    }
    return { config: DEFAULTS, path: null, errors: [], source: 'defaults' };
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    return {
      config: DEFAULTS,
      path: p,
      errors: [{ path: 'config', msg: `JSON 解析失败（${p}）：${e.message}` }],
      source: 'defaults',
    };
  }
  const v = validateChecks(raw);
  return { config: v.ok ? v.config : DEFAULTS, path: p, errors: v.errors, source: 'file' };
}

// ── 活文档范围：手写清单的失效方式是结构性的，这里给它配一条覆盖检查 ──────

/** 一条 scope 条目 → 匹配器。三种形态，都很朴素（不引第三方 glob）：
 *   - 以 `/` 结尾或磁盘上是目录 → 该目录下**递归**所有 `.md`
 *   - 含 `*` → 单段通配（`*` 不跨 `/`，`**` 跨）
 *   - 其余 → 一个具体文件
 */
function scopeMatcher(root, entry) {
  const e = normRel(entry);
  if (!e) return () => false;
  if (!e.includes('*') && existsSync(join(root, e)) && statSync(join(root, e)).isDirectory()) {
    return (rel) => rel.startsWith(e + '/') && rel.endsWith('.md');
  }
  if (!e.includes('*')) return (rel) => rel === e;
  const re = new RegExp('^' + e
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*') + '$');
  return (rel) => re.test(rel);
}

/** 盘上所有 `.md`（相对 root、正斜杠、排序稳定）。
 *  跳过 `.git` / `node_modules` / `dist` —— 它们是产物，不是文档。 */
export function listMarkdown(root, dir = String(root || '.')) {
  const out = [];
  const skip = new Set(['.git', 'node_modules', 'dist']);
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries.sort()) {
      if (skip.has(name)) continue;
      const full = join(d, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.md')) out.push(String(full).replace(/\\/g, '/').slice(String(root).replace(/\\/g, '/').length).replace(/^\/+/, ''));
    }
  };
  walk(dir);
  return out.sort();
}

/** scope 覆盖到的 `.md`（include 命中且 exclude 不命中）。 */
export function scopedMarkdown(root, scope = { include: [], exclude: [] }) {
  const include = (scope.include || []).map((e) => scopeMatcher(root, e));
  const exclude = (scope.exclude || []).map((e) => scopeMatcher(root, e));
  if (!include.length) return [];
  return listMarkdown(root).filter((rel) => include.some((m) => m(rel)) && !exclude.some((m) => m(rel)));
}

/**
 * 手写清单 vs 磁盘的差集。
 *
 * 为什么不是「扫所有 `.md` 减去排除」：实测本仓 177 份 `.md` 里有 93 份
 * `docs/research/`（历史报告）与 19 份 `docs/design/`（设计推演），把路径判据套上去
 * 当场会红 100+ 条 —— 其中最大的一份单文件 25 条。那些旧路径是**事实记录**，
 * 改写它们等于篡改历史。所以判据是：**手写清单 + 一条「清单必须覆盖 scope」的检查**，
 * 而不是把范围无限放大。
 *
 * scope 默认空 = 不开。列在 `livingDocsScan.include` 里的区域，多出任何一份未登记的
 * `.md` 就报红 —— 于是「新增活文档」这个动作再也逃不掉登记。
 *
 * @returns {{unregistered:string[], missing:string[]}}
 *   `unregistered` = 在 scope 里但清单没有；`missing` = 清单有但盘上没有。
 */
export function livingDocsGap(root, scope, registered = []) {
  const reg = new Set((registered || []).map(normRel));
  const covered = scopedMarkdown(root, scope);
  const unregistered = covered.filter((rel) => !reg.has(rel));
  const missing = [...reg].filter((rel) => rel && !existsSync(join(root, rel)));
  return { unregistered, missing };
}
