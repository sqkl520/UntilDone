#!/usr/bin/env node
/**
 * check-config.test.mjs — 「参数化之后本仓行为没变」的可执行证明。
 *
 * ## 为什么这个测试必须存在
 *
 * 6 个常量被提成配置之后，有一种失效方式是**任何一道门都抓不到的**：
 * 代码里的 `DEFAULTS` 改了，而 `.untildone/checks.json` 没跟着改（或反过来）。
 * 那时的表现是**本仓库的检查范围悄悄变了** —— 比如 `publishedDirs` 少一项之后
 * `docs/` 不再被扫，门照样绿，而它守的东西没了。这不是「报错」，是「检查消失」。
 *
 * 所以第一条测试**逐字对账**：`.untildone/checks.json` 解析出来的对象必须与
 * `DEFAULTS` 深度相等。它同时挡住两个方向的漂移：
 *   · 改了 `DEFAULTS` 忘改配置 → 配置落后；
 *   · 谁把配置改歪了（把 `scriptsDir` 写成 `src`）→ 本仓检查范围变了。
 *
 * 第二条进一步钉住「这份配置在本仓是 no-op」：**带配置跑硬门与不带配置跑硬门，
 * 输出必须逐字节相同**。第一条只证明数据相等，而「数据相等 ⇒ 行为相等」这一步
 * 依赖 `loadChecks()` 与硬门的接线；这一条把它变成实测（真跑两次子进程）。
 *
 * 第三条钉 `LIVING_DOCS` 的覆盖缺口：本仓 15 条手写清单漏了一份活文档时，
 * 测试红。这是 `checkLivingDocsCoverage()` 默认关闭之后唯一还响的地方
 * （默认关闭的理由见 `check-structure.mjs` 里 `LIVING_DOCS` 上方的注释）。
 *
 * 全部**真跑硬门**（子进程 + 临时 cwd），不复制判据 —— 复制判据只能证明
 * 「我抄的那份对」，而缺陷常在另一份里（`roles.test.mjs` 的同类注释）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, cpSync, existsSync, readdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DEFAULTS, CHECK_NAMES, CHECK_DOMAINS, domainOf, CONFIG_REL, loadChecks, validateChecks,
  livingDocsGap, scopedMarkdown, listMarkdown, normRel,
} from './check-config.mjs';

const REPO = join(import.meta.dirname, '..');
const CONFIG_PATH = join(REPO, CONFIG_REL);

/** 一个**最小的、可跑硬门的**项目：只放判据要读的那几份文件。
 *
 *  为什么不在本仓库里跑：那要让测试复制整棵仓库（含 177 份文档、`.github`、
 *  `tasks/runs` 的符号链接），实测一次 30 秒以上，而且会被工作区状态带偏
 *  （`cpSync` 跟着 `tasks/runs/ow-entry-sym-*` 跑出去报 `ESRCH`）。
 *
 *  这里要验的性质是「`loadChecks()` 读到一份等于 `DEFAULTS` 的配置之后，
 *  硬门的行为与没读到配置时一样」—— 那与仓库里有多少文档无关，所以最小项目就够，
 *  而且是**更强**的判据：大仓库里两边可能因为别的原因碰巧相同，小项目里没什么可巧合。
 *
 *  `scriptsDir` 默认 `scripts`，里面只放硬门自己 + 它 import 的 4 份模块。 */
function makeProject() {
  const d = mkdtempSync(join(tmpdir(), 'ow-checkconf-'));
  for (const rel of ['scripts', 'docs', 'templates', 'tasks/runs', '.claude/agents']) {
    mkdirSync(join(d, rel), { recursive: true });
  }
  // **这份清单必须跟着 `check-structure.mjs` 的本地 import 走。**
  //
  // 2026-11-22 实测：`check-structure.mjs` 新 import 了 `dispatch-quartet.mjs`，
  // 而这里没跟着拷 —— 于是硬门在临时项目里**在打印任何东西之前**就
  // `ERR_MODULE_NOT_FOUND` 崩掉。表现是「配置在生效」那行没有输出，
  // 测试报「改了形状却没打印配置在生效」，而真正的原因是夹具缺文件。
  //
  // 这条陷阱的形状值得记住：**夹具的失败看起来像被测代码的失败**。
  // 所以下面用「列出来 + 断言每个都存在」而不是静默跳过。
  const NEEDED = [
    'check-structure.mjs', 'check-config.mjs', 'roles.mjs',
    'published-paths.mjs', 'link-check.mjs', 'regression-count.mjs',
    'dispatch-quartet.mjs',
  ];
  for (const f of NEEDED) {
    const src = join(REPO, 'scripts', f);
    if (!existsSync(src)) throw new Error(`夹具缺 ${f} —— 它被 check-structure.mjs import，必须一起拷`);
    cpSync(src, join(d, 'scripts', f));
  }
  writeFileSync(join(d, '.gitignore'), 'tasks/runs/\n');
  writeFileSync(join(d, 'README.md'), '# demo\n\n不能自动接力。\n');
  writeFileSync(join(d, 'docs', 'CAPABILITIES.md'), '# caps\n\n| 能力 | 命令 |\n|---|---|\n');
  writeFileSync(join(d, 'tasks', 'runs', '.gitkeep'), '');
  return d;
}

const runGate = (cwd, env = {}) => {
  const r = spawnSync(process.execPath, [join(cwd, 'scripts', 'check-structure.mjs')], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

/** 往项目里写一份配置。`patch` 用来改形状。 */
function writeConfig(d, patch = {}) {
  mkdirSync(join(d, '.untildone'), { recursive: true });
  const cfg = { ...structuredClone(DEFAULTS), ...patch };
  writeFileSync(join(d, CONFIG_REL), JSON.stringify(cfg, null, 2));
}

// ── 1. 本仓配置 == 代码里的默认常量（逐字）────────────────────────────

test('本仓 .untildone/checks.json 与 DEFAULTS 深度相等——参数化了但本仓行为没变', () => {
  const text = readFileSync(CONFIG_PATH, 'utf8');
  const raw = JSON.parse(text);
  const cfg = validateChecks(raw);
  assert.deepEqual(cfg.errors, [], `本仓配置没通过自己的校验：${JSON.stringify(cfg.errors)}`);
  // `productRepo` 是**唯一一个刻意与默认值不同**的键，所以对账时把它换成默认值。
  //
  // 为什么它必须是例外：`DEFAULTS.productRepo = false` 是「对任何项目安全」的方向
  // （默认 true 会让每个陌生项目一进来就拿到 54 条「规定产物」违规 —— DF-051）。
  // 而本仓库**必须**是 `true`，否则本产品自己的规矩会静默不再执行。
  // 两者的差别是**这一位**，所以先把它抹平再逐字对账，其余键的严格性一分不减。
  // 它必须真的是 `true` 这件事由上面「productRepo 默认 false…」那条单独守。
  const normalized = { ...cfg.config, productRepo: DEFAULTS.productRepo };
  assert.deepEqual(
    normalized,
    DEFAULTS,
    '本仓配置与 DEFAULTS 不一致 —— 两边必须同步。DEFAULTS 是「代码里的现状」，'
    + '这份文件是「本仓声明的现状」，它们不同意味着本仓库的检查范围被悄悄改过'
    + '（唯一允许不同的是 productRepo，它在上面已经单独断言）。',
  );
});

test('本仓配置覆盖了 DEFAULTS 的每一个键（不多不少）', () => {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const keys = Object.keys(raw).filter((k) => k !== '$schema').sort();
  assert.deepEqual(keys, Object.keys(DEFAULTS).sort(),
    '配置文件的键集合必须与 DEFAULTS 一致：少一个键 = 那一项偷偷用了代码默认值，'
    + '多一个键 = 它不在 DEFAULTS 里，改 DEFAULTS 时不会有任何东西提醒你同步');
});

test('CHECK_NAMES 与硬门里实际注册的检查一一对应（否则 disabledChecks 会静默失效）', () => {
  // 从硬门源码里读 CHECKS 表的名字。**不 import 硬门**：它一被 import 就跑全部门禁并 exit。
  const src = readFileSync(join(REPO, 'scripts', 'check-structure.mjs'), 'utf8');
  const m = src.match(/const CHECKS = \[([\s\S]*?)\n\];/);
  assert.ok(m, '没找到硬门的 CHECKS 表 —— 结构变了，这条测试要跟着改');
  const names = [...m[1].matchAll(/^\s*\['([A-Za-z][\w]*?)',/gm)].map((x) => x[1]);
  assert.ok(names.length >= 20, `只解析出 ${names.length} 个检查名，解析规则可能失效了`);
  assert.deepEqual([...names].sort(), [...CHECK_NAMES].sort(),
    '硬门注册的检查名与 CHECK_NAMES 不一致 —— 用户在 disabledChecks 里写新名字会报「未知的检查名」，'
    + '而写旧名字（已改名）会**静默不关任何东西**');
});

// ── 2. 本仓配置是 no-op：带/不带配置跑硬门，输出逐字节相同 ──────────────

test('配置等于默认值时是 no-op：带/不带配置跑硬门，输出逐字节相同', () => {
  const d = makeProject();
  try {
    writeConfig(d);                       // 一份**等于 DEFAULTS** 的配置
    const withCfg = runGate(d);
    rmSync(join(d, '.untildone'), { recursive: true, force: true });
    const withoutCfg = runGate(d);
    assert.equal(withCfg.status, withoutCfg.status,
      `退出码不同：带配置 ${withCfg.status}，不带配置 ${withoutCfg.status}`);
    assert.equal(withCfg.out, withoutCfg.out,
      '输出不同 —— 一份等于 DEFAULTS 的配置改变行为，说明接线有问题'
      + `（或硬门在「有配置文件」时打了额外的话）。\n--- 带配置 ---\n${withCfg.out}\n--- 不带 ---\n${withoutCfg.out}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('配置与默认不同时必定打印一行——否则「我写了配置却没生效」无从分辨', () => {
  const d = makeProject();
  try {
    writeConfig(d, { scriptsDir: 'src' });
    const r = runGate(d);
    assert.match(r.out, /配置：/,
      '改了形状却没打印「配置在生效」——用户无法分辨配置有没有被读到');
    // 并且它必须真的换了形状：scripts/ 不再是脚本目录 → 那几条检查会报 src/ 不存在
    assert.match(r.out, /src/, `把 scriptsDir 改成 src 之后输出里没有 src —— 配置没生效：\n${r.out.slice(0, 600)}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ── 3. 非法配置：报错、不静默回落 ─────────────────────────────────────

test('未知键 = 错误（拼错 scriptsPrefix 不会被当成默认值忽略）', () => {
  const v = validateChecks({ scriptsPrefix: 'scripts/' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.path === 'scriptsPrefix'),
    `拼错的键必须报错，实际：${JSON.stringify(v.errors)}`);
});

test('类型不对 = 错误（不做 String(x) 那类隐式转换）', () => {
  for (const bad of [{ publishedDirs: 'docs' }, { livingDocs: [1] }, { agentsDir: 42 }]) {
    const v = validateChecks(bad);
    assert.equal(v.ok, false, `${JSON.stringify(bad)} 应当报错`);
  }
});

test('绝对路径 / 盘符 / ".." 一律不接受', () => {
  for (const bad of [
    { agentsDir: 'D:/x/agents' }, { scriptsDir: '/usr/local/scripts' },
    { privatePaths: ['../outside'] }, { runsDir: '' },
  ]) {
    const v = validateChecks(bad);
    assert.equal(v.ok, false, `${JSON.stringify(bad)} 应当报错`);
  }
});

test('runsDir 不在 privatePaths 里必须报错——否则台账会被当成可发布内容', () => {
  const v = validateChecks({ runsDir: 'tasks/runs', privatePaths: ['local'] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.path === 'runsDir'), JSON.stringify(v.errors));
});

test('disabledChecks 里的未知名字必须报错，不能静默不关任何东西', () => {
  const v = validateChecks({ disabledChecks: ['noSuchCheck'] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.path === 'disabledChecks'));
});

// ── 4. 配置文件缺失/损坏：两种情形必须可区分 ──────────────────────────

test('没有配置文件 → 用 DEFAULTS 且不报错（这是「本仓不写配置也照旧」的实现点）', () => {
  const d = mkdtempSync(join(tmpdir(), 'ow-checkconf-'));
  try {
    const r = loadChecks(d, { env: {} });
    assert.deepEqual(r.config, DEFAULTS);
    assert.equal(r.path, null);
    assert.equal(r.errors.length, 0);
    assert.equal(r.source, 'defaults');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('显式指定了不存在的配置 → 报错，不静默回落', () => {
  const r = loadChecks(tmpdir(), { configPath: join(tmpdir(), 'no-such-checks.json'), env: {} });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].msg, /不存在/);
});

test('配置 JSON 坏掉 → 报错 + 用默认值继续跑（别的检查仍要能报错）', () => {
  const d = mkdtempSync(join(tmpdir(), 'ow-checkconf-'));
  try {
    mkdirSync(join(d, '.untildone'), { recursive: true });
    writeFileSync(join(d, '.untildone', 'checks.json'), '{ "scriptsDir": ');
    const r = loadChecks(d, { env: {} });
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].msg, /JSON 解析失败/);
    assert.deepEqual(r.config, DEFAULTS, '配置坏掉时要用默认值继续，而不是让整个门停摆');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ── 5. 活文档覆盖：手写清单漏登记就红 ─────────────────────────────────

test('livingDocsScan 开着时，scope 里多出一份未登记的 .md 必须报出来', () => {
  const d = mkdtempSync(join(tmpdir(), 'ow-checkconf-'));
  try {
    mkdirSync(join(d, 'docs', 'spec'), { recursive: true });
    writeFileSync(join(d, 'docs', 'spec', 'a.md'), '# a\n');
    writeFileSync(join(d, 'docs', 'spec', 'b.md'), '# b\n');
    const gap = livingDocsGap(d, { include: ['docs/spec'], exclude: [] }, ['docs/spec/a.md']);
    assert.deepEqual(gap.unregistered, ['docs/spec/b.md']);
    assert.deepEqual(gap.missing, []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('清单里有、磁盘上没有 → 也报（清单漂了同样要可见）', () => {
  const d = mkdtempSync(join(tmpdir(), 'ow-checkconf-'));
  try {
    mkdirSync(join(d, 'docs'), { recursive: true });
    writeFileSync(join(d, 'docs', 'a.md'), '# a\n');
    const gap = livingDocsGap(d, { include: ['docs'], exclude: [] }, ['docs/a.md', 'docs/gone.md']);
    assert.deepEqual(gap.missing, ['docs/gone.md']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('scope 为空 = 不开（默认），此时不扫任何文件', () => {
  const d = mkdtempSync(join(tmpdir(), 'ow-checkconf-'));
  try {
    mkdirSync(join(d, 'docs'), { recursive: true });
    writeFileSync(join(d, 'docs', 'a.md'), '# a\n');
    assert.deepEqual(scopedMarkdown(d, { include: [], exclude: [] }), []);
    assert.deepEqual(livingDocsGap(d, { include: [], exclude: [] }, []).unregistered, []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('exclude 命中目录前缀时必须整棵排除（docs/spec/20* 这种日期报告）', () => {
  const d = mkdtempSync(join(tmpdir(), 'ow-checkconf-'));
  try {
    mkdirSync(join(d, 'docs', 'spec'), { recursive: true });
    writeFileSync(join(d, 'docs', 'spec', '2026-01-01-old.md'), '# old\n');
    writeFileSync(join(d, 'docs', 'spec', 'live.md'), '# live\n');
    const got = scopedMarkdown(d, { include: ['docs/spec'], exclude: ['docs/spec/20*'] });
    assert.deepEqual(got, ['docs/spec/live.md']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

/** 本仓手写清单对「现行活文档区」的覆盖缺口快照。
 *
 *  **这不是把缺口合法化**，是把它钉住：缺口从 8 份减到 7 份时下面这条会红，
 *  逼人更新这份快照（那时他会看见「原来清单还缺什么」）。
 *
 *  为什么用快照而不是直接红：`checkLivingDocsCoverage()` 默认关着，因为它一开
 *  本仓当场就红 8 条（现有 15 条清单是历史产物，补齐它要改文档，而本轮硬要求
 *  是本仓行为字节级不变）。缺口不许**变大**是刚性的，变小则是一条改文档的线索。
 *
 *  范围选 `docs/spec` + `docs/adr` + 根级 `.md`：那是「现行事实」的三处，
 *  `docs/design/`（全部未实现）与 `docs/research/`（过程记录，会过期）按定义不是活文档。
 *  `docs/spec/20*` 排除的是**带日期的验收快照**：它们记的是「某次改动当时怎么验的」，
 *  与 `CHANGELOG` 同类，属于事实记录，不是现行规格。
 */
test('本仓活文档清单的缺口不许变大（默认关闭的覆盖检查，靠这条钉住）', () => {
  const scope = { include: ['docs/spec', 'docs/adr', '*.md'], exclude: ['docs/spec/20*'] };
  const gap = livingDocsGap(REPO, scope, DEFAULTS.livingDocs);
  const unregistered = gap.unregistered.sort();
  const missing = gap.missing.sort();
  assert.deepEqual(missing, [], `清单里有磁盘上没有的文件：${missing.join(', ')}`);
  // 实测（2026-11-24）：**9 份** —— 5 份根级（CONTRIBUTING ×2 / SECURITY ×2 / README-EN）
  // + 3 份 adr（0003 / 0004 / 0005）+ 1 份 spec（original-design）。
  // （2026-11-21 是 8 份；`0005-stop-hook-scope.md` 是后来新增的一份现行 ADR。）
  //
  // 这个数**只许变小**：登记进 `livingDocs` 一份，上限就该跟着降一格。变大意味着
  // 又有一份现行文档没有被任何判据扫到 —— 那正是本条要拦的形态。
  assert.ok(unregistered.length <= 9,
    `活文档清单的缺口变大了（${unregistered.length} > 9）：${unregistered.join(', ')}
`
    + '新增一份现行文档（docs/spec / docs/adr / 根级 .md）必须登记进 '
    + '.untildone/checks.json 的 livingDocs，否则它不会被任何判据扫到。'
    + '登记之后这条断言的上限才该跟着降。');
});

// ── 6. 适用域（DF-051）：每一条检查都必须声明「对谁成立」 ────────────────

/** 这一组守的是 DF-051 的**机制面**。
 *
 *  修前硬门的 29 条检查是一个扁平表，其中一大半是「本产品自身的规矩」（README 必须
 *  声明不能自动接力、每个提交记 CHANGELOG、设计稿标未实现、能力清单绑命令……）。
 *  它们在别人的项目里没有对象 —— 实测一个只有 `README.md` + `git init` 的项目跑一遍
 *  报 **59 条违规，54 条的原话是「它是本仓库的规定产物」**。
 *
 *  修法不是「加十几条开关」（那要求用户先知道 17 个内部名字，而且下一次新加一条
 *  产品规矩又默认是红的）。修法是**给每条检查一个适用域**，域位由
 *  `.untildone/checks.json` 的 `productRepo` 决定要不要执行 product 那一族。
 *
 *  这一组钉住三件事：
 *    1. 每条检查**都**有域（漏登记 = 它在别人项目里默认报红，DF-051 复发）；
 *    2. 域只有两个取值（拼错成 `universel` 会让这条检查**永远不跑**）；
 *    3. `productRepo` 的默认值必须是 `false`（对任何项目安全），而本仓那份配置
 *       必须**显式**写 `true` —— 否则本仓自己的规矩会静默不再执行。 */
test('DF-051 每一条检查都声明了适用域，且只有 universal / product 两个取值', () => {
  for (const name of CHECK_NAMES) {
    const d = domainOf(name);
    assert.ok(d === 'universal' || d === 'product',
      `检查 "${name}" 的域是 ${JSON.stringify(d)} —— 只允许 universal / product。`
      + '拼错的域值不会报错，它只会让那条检查**永远不跑**（productRepo 判等失败）');
  }
  assert.equal(domainOf('this-is-not-a-check'), null,
    '未登记的名字必须返回 null（调用方据此报红），不能静默当成 universal');
});

test('DF-051 三个面都是 product 域：文档规矩 / 派发规矩 / 能力清单', () => {
  // 抽样而不是全列：这三个分别代表「只对本产品的文档成立」「只对本产品的架构成立」
  // 「只对本产品的交付物成立」。它们任何一条被误标成 universal，外部项目就会重新
  // 收到「要求你照抄我们的文档」的红。
  for (const n of ['capabilityDisclosure', 'dispatchQuartet', 'capabilities']) {
    assert.equal(domainOf(n), 'product',
      `"${n}" 必须是 product 域 —— 它在别人的项目里没有对象（DF-051 的原话是`
      + '「那不是检查，那是要求对方复制我们整套文档」）');
  }
  // 反向对照：这四条在任何项目里都成立，标成 product 会让它们在本仓之外静默不跑。
  for (const n of ['syntax', 'importable', 'absolutePaths', 'links']) {
    assert.equal(domainOf(n), 'universal',
      `"${n}" 必须是 universal 域 —— 它对任何仓库都成立，标成 product 会让别人的项目少查一条`);
  }
});

test('DF-051 productRepo 默认 false（对任何项目安全），本仓那份配置必须显式 true', () => {
  assert.equal(DEFAULTS.productRepo, false,
    'productRepo 的默认值必须是 false —— 默认 true 会让每个陌生项目一进来就拿到 54 条「规定产物」违规，'
    + '那正是 DF-051 要消灭的现象');
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  assert.equal(raw.productRepo, true,
    '本仓那份配置必须**显式**写 true —— 少了它，本产品自身的规矩（CHANGELOG / 设计索引 / '
    + '派发四元组 / 能力清单）会静默不再执行，而门照样绿');
});

test('DF-051 loadChecks 区分「显式写了这个键」与「没写」（declared）', () => {
  const d = mkdtempSync(join(tmpdir(), 'ow-checkconf-'));
  try {
    mkdirSync(join(d, '.untildone'), { recursive: true });
    // 只写一个键：其余全走默认值，但 `declared` 只能包含写了的那个。
    writeFileSync(join(d, CONFIG_REL), JSON.stringify({ scriptsDir: 'scripts' }));
    const r = loadChecks(d, { env: {} });
    assert.equal(r.source, 'file');
    assert.deepEqual([...r.declared], ['scriptsDir'],
      'declared 必须只含**显式写了的**键。它混进默认值时，「本仓声明了 productRepo=true」'
      + '与「本仓没写、恰好用了默认值」就分不出来');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ── 7. 硬门在陌生项目里：违规 ≤ 5 且都是真问题（DF-050 / DF-051 的完成判据）──

/** 一个**真正陌生**的项目：只有 `README.md` + `git init`。
 *
 *  这就是验收判据的原样：「在一个只有 README.md + git init 的项目里跑，违规 ≤ 5
 *  且都是真问题」。刻意**不**造 `scripts/` 之外任何东西 —— 夹具越像本仓，这条
 *  测试越证明不了「别人的项目不会被要求照抄」。
 *
 *  `scripts/` 里只放硬门 + 它的全部本地 import（跟着源码走，见 `makeProject()` 的注释）。 */
function makeAlienProject() {
  const d = mkdtempSync(join(tmpdir(), 'ow-alien-'));
  mkdirSync(join(d, 'scripts'), { recursive: true });
  writeFileSync(join(d, 'README.md'), '# 一个跟 UntilDone 无关的小项目\n\n做一件事。\n');
  const NEEDED = [
    'check-structure.mjs', 'check-config.mjs', 'roles.mjs',
    'published-paths.mjs', 'link-check.mjs', 'regression-count.mjs',
    'dispatch-quartet.mjs',
  ];
  for (const f of NEEDED) cpSync(join(REPO, 'scripts', f), join(d, 'scripts', f));
  // git init：`gitPublishableRootFiles()` 用 git 判「会不会发出去」。
  spawnSync('git', ['init', '-q', '.'], { cwd: d });
  return d;
}

/** 只取输出里**违规**那一节的行（「未跑」与「提示」也以两空格+方括号开头）。 */
function violationLines(out) {
  const head = out.indexOf('项违规');
  if (head < 0) return [];
  const end = out.indexOf('\n— ');
  return out.slice(head, end < 0 ? undefined : end)
    .split('\n').filter((l) => /^ {2}\[/.test(l));
}

test('DF-051 陌生项目（只有 README.md + git init）里违规 ≤ 5，且没有一条是「要求照抄我们的文档」', () => {
  const d = makeAlienProject();
  try {
    const r = runGate(d);
    const viol = violationLines(r.out);
    assert.ok(viol.length <= 5,
      `陌生项目里报了 ${viol.length} 条违规（判据 ≤ 5）：\n${viol.join('\n')}\n`
      + '超过 5 条说明又有判据把「本产品自身的规矩」当成「任何项目的合格线」（DF-051）');

    for (const l of viol) {
      assert.ok(!/本仓库的规定产物|本产品自身的规定产物/.test(l),
        `违规里出现「规定产物」这句话：${l}\n`
        + '这句话在别人的项目里字面上就是要求对方复制我们整套文档 —— productRepo 没有接上');
    }

    // 「产品规矩本轮不适用」这一行必须出现：域位关掉的东西必须看得见（不静默）。
    assert.match(r.out, /本产品自身的规矩本轮不适用/,
      'productRepo=false 时没有打印「哪一族规矩不适用」—— 那就成了静默关掉，'
      + '「本产品规矩全部通过」与「一条都没跑」在屏幕上同形（DF-047 的老病）');
    assert.match(r.out, /productRepo/,
      '提示里必须写出开关名字，否则读者不知道该怎么打开这一族');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('DF-051 正向对照：productRepo=true 时同一个陌生项目必须重新报出那些「规定产物」', () => {
  // 这条是上一条的**负向验证**：`≤ 5` 必须是因为域位关掉了那一族，而不是因为门
  // 恰好什么都没查。判据用「同一份夹具 + 只翻 `productRepo` 一位」，两个方向都实测。
  const d = makeAlienProject();
  try {
    const off = violationLines(runGate(d).out);
    mkdirSync(join(d, '.untildone'), { recursive: true });
    writeFileSync(join(d, '.untildone', 'checks.json'), JSON.stringify({ productRepo: true }, null, 2));
    const r = runGate(d);
    const on = violationLines(r.out);
    assert.ok(on.length > off.length + 10,
      `productRepo=true 时只报了 ${on.length} 条（关着时 ${off.length} 条）—— 产品规矩没有被执行。`
      + '这条是正向对照：它证明「≤ 5」不是因为门什么都没查');
    assert.ok(on.some((l) => /docs\/CHANGELOG\.md/.test(l)),
      `productRepo=true 时没有报 CHANGELOG 缺失 —— 产品规矩没接上：\n${on.slice(0, 8).join('\n')}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ── 8. 硬门不在被检查的项目里留垃圾（DF-050 的另一半）──────────────

test('DF-050 跑门前后，陌生项目的 git status 必须干净（不留 tasks/runs 之类的垃圾）', () => {
  const d = makeAlienProject();
  try {
    const status = () => spawnSync('git', ['status', '--porcelain', '--untracked-files=all'],
      { cwd: d, encoding: 'utf8' }).stdout || '';
    // 基线里滤掉 `scripts/` —— 那是夹具本身（脚本副本），与门是否写盘无关。
    const clean = (s) => s.split('\n').filter((l) => l && !l.includes('scripts/')).sort();
    const before = clean(status());
    runGate(d);
    const after = clean(status());
    assert.deepEqual(after, before,
      `跑一次硬门在陌生项目里留下了东西：\n  新增：${after.filter((x) => !before.includes(x)).join(', ') || '(无)'}\n`
      + '最常见的是 tasks/runs/ —— 根因是 regression-count 的探针 import 测试文件时，'
      + '`entry-symlink.test.mjs` 的 `makeTmp()` 在模块级建了目录（DF-050）');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
