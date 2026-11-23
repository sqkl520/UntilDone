// 角色注册表（`scripts/roles.mjs`）的回归测试。
//
// 这一份守的是「同一件事只写一次」那件事本身 —— 所以它刻意用**真身**：
// 真的扫 `.claude/agents/`，真的跑 `compose-agent-prompt.mjs` 与 `check-structure.mjs`
// 的子进程。从源码正则里提取清单再自己拼一份 = 自证，本仓栽过好几次（DF-039/DF-040/DF-042）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { validateChecks } from './check-config.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  discoverRoles, resolveRole, roleIndex, labelOf, parseFrontmatter, readonlyOf,
  idFromName, truthyFlag, agentPrefixFrom, agentsDir, agentsDirCandidates, probeAgentsDir,
  defaultRoles, displayPath, DEFAULT_AGENT_PREFIX,
  rolesFor, capabilitiesFor, rolesDirFor, sourceText,
} from './roles.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const AGENTS = join(REPO, '.claude', 'agents');

const tmp = () => mkdtempSync(join(tmpdir(), 'ow-roles-'));

/** 造一份角色定义。**故意不给 `id:`** —— 那是现有 12 份的形态，
 *  也是「去前缀得 id」这条规则唯一会被真正走到的分支。 */
const agentMd = ({ name, tools = 'Read, Grep', readonly = true, display = '', extra = '' }) => [
  '---',
  `name: ${name}`,
  'description: 测试用的角色定义，正文无所谓，只要 frontmatter 完整。',
  `tools: ${tools}`,
  ...(readonly === null ? [] : [`readonly: ${readonly}`]),
  ...(display ? [`display: ${display}`] : []),
  ...(extra ? [extra] : []),
  '---',
  '',
  '正文。',
  '',
].join('\n');

// ── 1. id 集合逐字不变（任务硬要求 3）───────────────────────────────

/** 2026-11-21 收敛前的 12 个 id，**从当时那三份字面量清单抄下来的**。
 *  这不是「再抄一份第二真源」：它是**历史快照**，作用与 CHANGELOG 里的旧数字相同 ——
 *  证明这次重构没顺手改名。真源是目录，这里钉的是「目录解析出来的结果没变」。 */
const IDS_AT_CONVERGENCE = [
  'acceptor', 'critic', 'executor', 'planner', 'probe', 'redteam',
  'relay', 'repair', 'research', 'resolution', 'review', 'safety',
];

test('12 份现有角色文件的 id 集合与收敛前逐字相同', () => {
  const roles = discoverRoles(AGENTS);
  const byName = new Map(roles.map((r) => [r.name, r]));

  // 判据是**每一个历史 id 都还在、且拼写没变**，而不是「总数必须恰好 12」。
  // 差别很重要：钉总数会让「加一个角色」必须改这个测试文件，
  // 而这条快照要守的是「重构没顺手改名/删角色」——新增不该被它拦。
  const missing = IDS_AT_CONVERGENCE.filter((id) => !byName.has(DEFAULT_AGENT_PREFIX + id));
  assert.deepEqual(missing, [],
    `这些角色在收敛前存在，现在没了或改名了：${missing.join(', ')}。`
    + '若是有意删/改名，改这份快照并在 CHANGELOG 写明；若没打算动，说明前缀规则或 frontmatter 被改坏了');

  // 逐字：id 必须是「全名去前缀」的结果，也不许被 frontmatter 的 id: 悄悄改写。
  // （`id:` 优先是给复用者准备的逃生口；本仓这 12 份不该用它。）
  for (const id of IDS_AT_CONVERGENCE) {
    const r = byName.get(DEFAULT_AGENT_PREFIX + id);
    assert.equal(r.id, id, `${r.name} 的 id 变成了 ${r.id}`);
    assert.equal(r.name, DEFAULT_AGENT_PREFIX + r.id, `${r.name} 与它的 id ${r.id} 不一致`);
  }
});

test('全名与 id 是同一批角色，且 id 恰好等于全名去掉 agentPrefix', () => {
  const roles = discoverRoles(AGENTS);
  for (const r of roles) {
    assert.equal(r.name, DEFAULT_AGENT_PREFIX + r.id, `${r.name} 去前缀应当是 ${r.id}`);
    assert.ok(r.file.endsWith(`${r.name}.md`), `file 应指向 ${r.name}.md，实际 ${r.file}`);
    assert.ok(r.file.startsWith(AGENTS), 'file 必须是绝对路径（调用方要直接读它）');
  }
});

test('id 取值规则：frontmatter 写了 id 就用它，没写才去前缀', () => {
  const d = tmp();
  try {
    mkdirSync(join(d, 'agents'));
    writeFileSync(join(d, 'agents', 'oversight-alpha.md'), agentMd({ name: 'oversight-alpha' }));
    writeFileSync(join(d, 'agents', 'oversight-beta.md'),
      agentMd({ name: 'oversight-beta', extra: 'id: explicit-beta' }));
    // 别人的角色目录：名字不带 oversight-，去前缀不成立，id 就是它自己
    writeFileSync(join(d, 'agents', 'my-review-helper.md'), agentMd({ name: 'my-review-helper', readonly: false }));
    const ids = discoverRoles(join(d, 'agents')).map((r) => r.id).sort();
    assert.deepEqual(ids, ['alpha', 'explicit-beta', 'my-review-helper']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('idFromName：前缀是参数，不是写死的假设', () => {
  assert.equal(idFromName('oversight-planner'), 'planner');
  assert.equal(idFromName('oversight-planner', 'oversight-'), 'planner');
  assert.equal(idFromName('ow-planner', 'ow-'), 'planner');
  // 前缀不匹配时原样返回，**绝不去猜**（猜的后果是 my-review-helper 被当成 review 的别名）
  assert.equal(idFromName('my-review-helper', 'oversight-'), 'my-review-helper');
  // 名字恰好等于前缀：不能返回空串（id 为空会让下游按空键查到别人）
  assert.equal(idFromName('oversight-', 'oversight-'), 'oversight-');
});

test('agentPrefixFrom：读配置，读不出就回落默认值而不是抛', () => {
  const d = tmp();
  try {
    writeFileSync(join(d, 'overwatch.config.json'), JSON.stringify({ agent: { roster: ['x'], agentPrefix: 'ow-' } }));
    assert.equal(agentPrefixFrom(d), 'ow-');
    // 没有配置文件
    assert.equal(agentPrefixFrom(join(d, 'nope')), DEFAULT_AGENT_PREFIX);
    // 坏 JSON：注册表不负责校验配置（那是 validateConfig 的事），这里必须不炸
    writeFileSync(join(d, 'overwatch.config.json'), '{ not json');
    assert.equal(agentPrefixFrom(d), DEFAULT_AGENT_PREFIX);
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'sub', 'overwatch.config.json'), '{ not json');
    assert.equal(agentPrefixFrom(join(d, 'sub')), DEFAULT_AGENT_PREFIX);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('目录不存在 → 返回空注册表（不是内置清单）', () => {
  // 内置清单的失效方式：目录被删了，一切看起来正常。空表让下游立刻报「一个角色都不合法」。
  assert.deepEqual(discoverRoles(join(REPO, '.claude', 'agents-nonexistent')), []);
  assert.deepEqual(discoverRoles(''), []);
});

// ── 2. 严格放宽：两种名字都能用（任务硬要求 2）──────────────────────

test('resolveRole：全名与 id 都解析到同一条记录', () => {
  const roles = discoverRoles(AGENTS);
  const a = resolveRole(roles, 'acceptor');
  const b = resolveRole(roles, 'oversight-acceptor');
  assert.ok(a && b, '两种写法都必须解析得到');
  assert.equal(a.file, b.file, '同一个角色解析到两份文件 = 三个名字空间没收敛');
  assert.equal(a.id, 'acceptor');

  // 真的找不到时必须返回 null —— 回落成「随便挑一个」会让 compose 发错岗位的提示词
  assert.equal(resolveRole(roles, 'nosuchrole'), null);
  assert.equal(resolveRole(roles, ''), null);
  assert.equal(resolveRole(roles, null), null);
});

test('resolveRole：前缀重试那一支真的存在（name 不带前缀的角色也能按短名调用）', () => {
  const roles = [{ id: 'alpha', name: 'ow-alpha', file: '/x/ow-alpha.md', tools: [], readonly: false, forbiddenContext: [], display: 'alpha' }];
  assert.equal(resolveRole(roles, 'alpha').name, 'ow-alpha', 'id 与 name 都不同时，靠加前缀再试一次');
  assert.equal(resolveRole(roles, 'alpha', { agentPrefix: 'ow-' }).name, 'ow-alpha');
});

test('CLI 端到端：--role acceptor 与 --role oversight-acceptor 都能过角色解析', () => {
  const d = tmp();
  try {
    const runDir = join(d, 'tasks', 'runs', 'r1');
    mkdirSync(runDir, { recursive: true });
    const graph = join(runDir, 'task-graph.json');
    writeFileSync(graph, JSON.stringify({
      run_id: 'r1', root_goal: 'g', constraints: [],
      subtrees: [{
        id: 'ST1', goal: '对交付物逐项判定，按预声明标准给出通过或不通过与证据引用',
        capability: 'acceptor', shape: 'artifact', token_budget_pct: 20, timeout_min: 10,
        parallel_with: [], depends_on: [],
        acceptance: [{ id: 'AC1', criterion: 'a.md:1 有东西', evidence: 'a.md:1', fail_if: '没有' }],
        outputs: ['a.md'], why_this_layer: 'w',
      }],
    }));
    const cli = join(REPO, 'scripts', 'compose-agent-prompt.mjs');
    const base = ['compose', '--run', 'r1', '--task', 'ST1', '--graph', graph,
      '--stop', '每项 AC 必带 file:line，10 分钟内返回'];
    const short = spawnSync(process.execPath, [cli, ...base, '--role', 'acceptor', '--dry-run'], { encoding: 'utf8' });
    const full = spawnSync(process.execPath, [cli, ...base, '--role', 'oversight-acceptor', '--dry-run'], { encoding: 'utf8' });

    // 两条都必须**走到角色解析之后**：判据是输出里出现「角色 <名字>」这句检查行，
    // 而不是「exit 0」—— 检查不过也会 exit 1，用退出码判会把两者混为一谈。
    assert.match(short.stdout + short.stderr, /角色 acceptor/, `短名没解析到：\n${short.stdout}${short.stderr}`);
    assert.match(full.stdout + full.stderr, /角色 oversight-acceptor/, `全名没解析到：\n${full.stdout}${full.stderr}`);
    // 复现那条原始报错：拼出 oversight-oversight- 的路径不能再次出现
    assert.ok(!/oversight-oversight-/.test(full.stdout + full.stderr),
      `全名仍然被二次拼前缀：\n${full.stdout}${full.stderr}`);
    assert.ok(!/没有这个角色的定义/.test(full.stdout + full.stderr),
      `全名仍然被报成「不存在」：\n${full.stdout}${full.stderr}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ── 3. 暗雷：只读不再靠名字子串匹配（任务硬要求 4）────────────────

test('readonly 读 frontmatter：my-review-helper 不因名字含 review 被强制只读', () => {
  const d = tmp();
  try {
    const agents = join(d, '.claude', 'agents');
    mkdirSync(agents, { recursive: true });
    // 名字里带 review，但显式写了 readonly: false，且有写工具。
    // 旧实现（READONLY_ROLES.some(r => name.includes(r))）会把它当成只读角色，
    // 于是「拥有写工具」这条与本文件毫无关系的告警会落在它头上，而它自己说的是 false。
    writeFileSync(join(agents, 'my-review-helper.md'),
      agentMd({ name: 'my-review-helper', tools: 'Read, Write, Edit, Bash', readonly: false }));

    const roles = discoverRoles(agents);
    assert.equal(roles.length, 1);
    assert.equal(roles[0].readonly, false,
      '名字含 review 就被判只读 —— 这就是那条子串匹配的暗雷');

    // 硬门必须对它放行。**跑真身**（子进程 + 临时 cwd），不复制判据。
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'check-structure.mjs')], {
      cwd: d, encoding: 'utf8',
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(!/my-review-helper/.test(out),
      `硬门对 my-review-helper 报了违规（它自己声明 readonly: false）：\n${out}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('只读角色的工具越界仍然被拦（改判据之后检查没有变松）', () => {
  const d = tmp();
  try {
    const agents = join(d, '.claude', 'agents');
    mkdirSync(agents, { recursive: true });
    // readonly: true + Edit/Bash，且正文没有任何「只能写报告」的申明 —— 必须红。
    writeFileSync(join(agents, 'oversight-strict.md'),
      agentMd({ name: 'oversight-strict', tools: 'Read, Edit, Bash', readonly: true }));
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'check-structure.mjs')], {
      cwd: d, encoding: 'utf8',
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.notEqual(r.status, 0, `应当有违规，实际 exit ${r.status}：\n${out}`);
    assert.match(out, /只得拥有 Edit\/Bash|不得拥有 Edit\/Bash|只读角色/,
      `没报「只读角色拥有写工具」：\n${out}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('缺 readonly 行本身要报错——否则「忘了写」的失效方式是静默放行', () => {
  const d = tmp();
  try {
    const agents = join(d, '.claude', 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'oversight-forgot.md'), agentMd({ name: 'oversight-forgot', readonly: null }));
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'check-structure.mjs')], {
      cwd: d, encoding: 'utf8',
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.notEqual(r.status, 0, `缺 readonly 应当报错：\n${out}`);
    assert.match(out, /缺少必填字段 "readonly"/, `报的不是「缺 readonly」：\n${out}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('现有 12 份定义全部写明了 readonly（不是靠默认值）', () => {
  for (const r of discoverRoles(AGENTS)) {
    const fm = parseFrontmatter(readFileSync(r.file, 'utf8'));
    assert.ok(fm && fm.readonly !== undefined && fm.readonly !== '',
      `${r.name} 没写 readonly —— 那就没人想过这个角色该不该有写权限`);
    assert.ok(['true', 'false'].includes(String(fm.readonly).trim()), `${r.name} 的 readonly 是 "${fm.readonly}"`);
    assert.equal(readonlyOf(fm), String(fm.readonly).trim() === 'true');
  }
});

test('truthyFlag 只认明确写法：`readonly: ture` 不许静默变成 true', () => {
  for (const t of ['true', 'TRUE', 'yes', 'on', '1', ' true ']) assert.equal(truthyFlag(t), true, t);
  for (const f of ['false', 'no', 'off', '0', '', null, undefined, 'ture', 'flase', 'maybe']) {
    assert.equal(truthyFlag(f), false, String(f));
  }
});

// ── 4. 其余投影：显示名 / 索引 / 禁止上下文 ─────────────────────────

test('labelOf：取 frontmatter 的 display，缺省回落 id（不内置中文表）', () => {
  const roles = [
    { id: 'acceptor', name: 'oversight-acceptor', display: '验收' },
    { id: 'mystery', name: 'oversight-mystery', display: '' },
  ];
  // display 为空串时 discoverRoles 已经回落成 id；这里再兜一层，防止调用方手造的记录
  assert.equal(labelOf(roles, 'acceptor'), '验收');
  assert.equal(labelOf(roles, 'oversight-acceptor'), '验收', '全名也要能查到标签');
  assert.equal(labelOf(roles, 'mystery'), '');
  // 表里没有的 capability：原样返回，**不是** '—'（'—' 会让「谁能干这事」看起来像「没人」）
  assert.equal(labelOf(roles, 'unknown-cap'), 'unknown-cap');
  assert.equal(labelOf(roles, ''), '—');
});

test('roleIndex 同时按 id 与全名建键，且指向同一条记录', () => {
  const idx = roleIndex(discoverRoles(AGENTS));
  assert.equal(idx.acceptor, idx['oversight-acceptor']);
  assert.equal(idx.acceptor.id, 'acceptor');
});

test('每个角色都有 forbiddenContext 数组（缺省是空数组，不是 undefined）', () => {
  for (const r of discoverRoles(AGENTS)) {
    assert.ok(Array.isArray(r.forbiddenContext), `${r.name} 的 forbiddenContext 不是数组`);
  }
  const idx = roleIndex(discoverRoles(AGENTS));
  // 关键的三条：锚定的失效方式是静默的，所以清单本身要被钉住
  assert.ok(idx.acceptor.forbiddenContext.includes('review_score'), '验收不得拿到锐评分数');
  assert.ok(idx.review.forbiddenContext.includes('self_assessment'), '锐评不得拿到执行者自评');
  assert.deepEqual(idx.executor.forbiddenContext, [], '执行者没有额外禁止项');
});

test('parseFrontmatter 两种入参都收（整份文件 / 围栏内正文）', () => {
  const whole = '---\nname: a\ntools: Read\n---\n正文';
  assert.deepEqual(parseFrontmatter(whole).name, 'a');
  // 硬门的历史调用方式：先自己剥掉围栏，再把正文传进来
  assert.deepEqual(parseFrontmatter('name: a\ntools: Read').name, 'a');
  // 两者对同一份文件必须给出同一个结论
  assert.deepEqual(parseFrontmatter(whole), parseFrontmatter('name: a\ntools: Read'));
  // 真的没有 frontmatter：null（不是空对象 —— 空对象会伪装成「字段都没写」）
  assert.equal(parseFrontmatter('只有正文，没有 frontmatter'), null);
  assert.equal(parseFrontmatter(''), null);
});

test('parseFrontmatter 支持多行块（否则多行 description 会被误判为空）', () => {
  const fm = parseFrontmatter('---\nname: a\ndescription: |\n  第一行\n  第二行\ntools: Read\n---\n');
  assert.equal(fm.description, '第一行 第二行');
  assert.equal(fm.tools, 'Read');
});

// ── 5. 按根求值：项目角色必须被看见（2026-11-21，D2 验证的根因）─────────
//
// 这一组的每一条都在守同一件事：**「有哪些角色」不是常量，是按根求值的结果。**
// 修前 `validate-run.mjs` 是 `export const CAPABILITIES = discoverRoles()`，
// 模块加载时执行 → 永远读框架自己的目录。实测（`%TEMP%` 下一个只有 qa/reviewer 的项目）：
//   capability: "qa"       → exit 1「不在合法取值内」
//   capability: "executor" → exit 0（项目里根本没这个角色）
// 后半句比修前更糟。所以下面**既钉「项目角色被看见」，也钉「项目里不存在的被拒」**。

/** 造一个「真项目」：`.claude/agents/` + 可选配置。`git init` 只为了让
 *  `projectRoot()` 的阶梯在子进程里也能认出它（端到端用例需要）。 */
function makeProject({ agents = {}, config = null } = {}) {
  const d = tmp();
  const dir = join(d, '.claude', 'agents');
  mkdirSync(dir, { recursive: true });
  for (const [file, spec] of Object.entries(agents)) {
    writeFileSync(join(dir, `${file}.md`), agentMd(spec));
  }
  if (config) writeFileSync(join(d, 'overwatch.config.json'), JSON.stringify(config));
  return d;
}

test('rolesFor：项目有角色目录 → 只认项目，不并入框架', () => {
  const d = makeProject({ agents: { qa: { name: 'qa', display: '质量' } } });
  try {
    const set = rolesFor(d);
    assert.equal(set.source, 'project');
    assert.deepEqual(set.roles.map((r) => r.id), ['qa'],
      '项目里的角色表被并入了框架的 12 个 —— 那样「项目里不存在的 capability」会照样合法');
    assert.equal(set.dir, join(d, '.claude', 'agents'), 'dir 必须是项目的绝对路径（调用方要直接读它）');
    assert.equal(set.roles[0].display, '质量');
    assert.equal(capabilitiesFor(d).join(','), 'qa');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rolesFor：项目没有角色目录 → 框架兜底，并如实标 source', () => {
  const d = tmp(); // 空目录，没有 .claude/agents
  try {
    const set = rolesFor(d);
    assert.equal(set.source, 'framework');
    assert.ok(set.roles.length >= 12, `框架兜底应当拿到全部角色，实际 ${set.roles.length}`);
    assert.equal(set.dir, agentsDir());
    assert.deepEqual(set.tried.map((t) => t.dir), agentsDirCandidates(),
      '`tried` 必须覆盖**全部**候选（顺序即优先级），不只是被选中的那个');
    // `null` = 只认框架，不需要任何项目在盘上
    assert.equal(rolesFor(null).source, 'framework');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rolesFor：空目录也算「没有」—— 空注册表会让下游「一个角色都不合法」', () => {
  const d = makeProject({ agents: {} }); // 目录在，但一份 .md 都没有
  try {
    assert.equal(rolesFor(d).source, 'framework', '空目录不该被当成「这个项目没有角色」，那等于全拒');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rolesFor：前缀取**项目自己的配置**，不是框架的 oversight-', () => {
  const d = makeProject({
    agents: { 'ow-qa': { name: 'ow-qa', display: '质量' } },
    config: { agent: { agentPrefix: 'ow-' } },
  });
  try {
    const set = rolesFor(d);
    assert.equal(set.agentPrefix, 'ow-');
    assert.deepEqual(set.roles.map((r) => r.id), ['qa'],
      '项目配了 ow- 前缀却没生效 —— 这是缺陷 3：compose --role qa 会报「现有角色：ow-qa」');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('sourceText：必须说清「这份注册表来自哪」', () => {
  const d = makeProject({ agents: { qa: { name: 'qa' } } });
  try {
    const proj = sourceText(rolesFor(d), d);
    assert.match(proj, /项目角色目录/);
    assert.match(proj, /1 个/);
    assert.ok(!proj.includes(d), `打印了绝对路径（含本机目录）：${proj}`);
    const fw = sourceText(rolesFor(null));
    assert.match(fw, /框架角色目录/);
    assert.match(fw, /用户项目里没有/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rolesDirFor：纯路径拼接，空根返回 null（不拼出相对路径）', () => {
  assert.equal(rolesDirFor('/p'), join('/p', '.claude', 'agents'));
  assert.equal(rolesDirFor(''), null);
  assert.equal(rolesDirFor(null), null);
});

// ── DF-062：框架角色目录必须按**实际布局**发现，不是写死 `.claude/agents` ────
//
// 缺陷形态：`AGENTS_DIR` 是模块加载时求值的常量 `resolve(HERE,'..','.claude','agents')`。
// 本仓自用形态下它是对的；plugin 载荷形态下包根是 `<payload>`，角色在 `<payload>/agents`
// （宿主的 plugin 布局，实测只认根下一层），于是 `rolesFor()` 的框架兜底认到 **0 个角色**。
// 实测输出（修前，外部项目里跑载荷里的 validate-run）：
//
//   [validate-run] 角色表 → 框架角色目录 …\payload\.claude\agents（0 个；…）
//
// 下面这一组**不用进程内 import 证明修复**：真正的判据是「换一个包根，它读哪个目录」。
// 载荷形态不可能在进程内伪造（脚本位置由 `import.meta.url` 决定），所以最后一条走
// 真子进程 + 真生成的载荷目录 —— 与端到端用例同一个理由：缺陷在模块加载时机上。

test('DF-062 agentsDir/agentsDirCandidates：候选顺序即优先级，且按「有角色」挑而不是「存在」', () => {
  const cands = agentsDirCandidates('/pkg');
  assert.deepEqual(cands, [join('/pkg', '.claude', 'agents'), join('/pkg', 'agents')],
    '候选顺序变了 —— 顺序即优先级，先 .claude/agents 才与本仓历史行为一致');
  assert.deepEqual(agentsDirCandidates(''), [], '空根不许拼出相对路径');
  assert.deepEqual(agentsDirCandidates(null), []);

  const d = tmp();
  try {
    // 1) 只有载荷布局：<pkg>/agents
    mkdirSync(join(d, 'agents'), { recursive: true });
    writeFileSync(join(d, 'agents', 'oversight-qa.md'), agentMd({ name: 'oversight-qa' }));
    assert.equal(agentsDir(d), join(d, 'agents'), '载荷布局（<pkg>/agents）没被认出来 —— DF-062 原样复发');

    // 2) 两种都在、**两边都有角色**：先 .claude/agents
    mkdirSync(join(d, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(d, '.claude', 'agents', 'oversight-qa.md'), agentMd({ name: 'oversight-qa' }));
    assert.equal(agentsDir(d), join(d, '.claude', 'agents'), '两种都有角色时必须取 .claude/agents（顺序即优先级）');

    // 3) **整改第 2 条**：`.claude/agents` 是一个空目录、`agents/` 有角色 → 必须取后者。
    //    修前判据是 `existsSync`，于是这个形态「12 个角色 → 0 个」。
    rmSync(join(d, '.claude', 'agents', 'oversight-qa.md'));
    assert.equal(agentsDir(d), join(d, 'agents'),
      '空目录把候选占了 —— 「存在」被当成「有角色」，DF-062 整改第 2 条原样复发');
  } finally { rmSync(d, { recursive: true, force: true }); }

  // 4) 两个都不在：返回**第一个候选**而不是 null / 空串。
  //    判据是「报错文案要指得出该去建哪个目录」—— null 会让下游打出「框架角色目录 （0 个）」。
  const empty = tmp();
  try {
    assert.equal(agentsDir(empty), join(empty, '.claude', 'agents'));
  } finally { rmSync(empty, { recursive: true, force: true }); }
  assert.equal(agentsDir(''), null);
});

test('DF-062 整改①：sourceText 按**实际发生的事**说，且绝不打印绝对路径', () => {
  const pkg = tmp();
  try {
    mkdirSync(join(pkg, 'agents'), { recursive: true });
    writeFileSync(join(pkg, 'agents', 'oversight-qa.md'), agentMd({ name: 'oversight-qa' }));
    mkdirSync(join(pkg, '.claude', 'agents'), { recursive: true });  // 空目录：有 0 个角色
    const probe = probeAgentsDir(pkg);
    assert.deepEqual(probe.tried.map((t) => [t.state, t.count]),
      [['dir', 0], ['dir', 1]], '探测明细不对 —— sourceText 的事实来源就是它');
    assert.equal(probe.dir, join(pkg, 'agents'), '空候选抢走了位置（整改第 2 条）');
    // 前缀必须传进扫描（`probeAgentsDir` 的第二参数）：id 是「name 去前缀」，
    // 前缀不同 id 就不同 —— `rolesFor()` 的框架前缀可能来自别人的 `overwatch.config.json`。
    // 拿默认前缀扫出来的 id 会给出一份**看着正常但全错**的注册表。
    const prefixed = probeAgentsDir(pkg, { agentPrefix: 'ow-' });
    assert.deepEqual(prefixed.roles.map((r) => r.id), ['oversight-qa'],
      '前缀没生效（`ow-` 对不上 `oversight-qa`，id 应当原样保留）');
    writeFileSync(join(pkg, 'agents', 'ow-qa.md'), agentMd({ name: 'ow-qa' }));
    assert.deepEqual(probeAgentsDir(pkg, { agentPrefix: 'ow-' }).roles.map((r) => r.id).sort(), ['oversight-qa', 'qa'],
      '前缀 `ow-` 没被用上 —— `ow-qa` 的 id 应当变成 `qa`');

    // 有角色时：不铺候选清单（噪音），且路径里不许出现绝对路径
    const ok = sourceText({ source: 'framework', dir: probe.dir, tried: probe.tried, roles: [{ id: 'a' }] }, '/nonexistent-proj');
    assert.ok(!/试过/.test(ok), `找到了角色还把候选铺出来（噪音）：${ok}`);
    assert.ok(!ok.includes(pkg), `泄漏了绝对路径：${ok}`);
    assert.match(ok, /（1 个/, ok);
    // 这个夹具包根不在 `REPO_ROOT` 底下，所以走 `displayPath` 的第 3 级回落
    // （既不在 root 下、也不在包根下）—— 形态必须是 `<abs>/…/agents`，不是 `C:\…`。
    assert.match(ok, /<abs>\/[^/]+\/agents/, ok);

    // 0 个角色时：逐个候选说出**实际状态**。
    // 这里钉的是整改第 1 条 —— 修前一律说「都不存在或为空」，而实测里
    // 「存在、有 12 个角色、只是排在后面」也被这么说，那是假话。
    const zero = sourceText({
      source: 'framework',
      dir: join(pkg, '.claude', 'agents'),
      tried: [
        { dir: join(pkg, '.claude', 'agents'), state: 'notdir', count: 0 },
        { dir: join(pkg, 'agents'), state: 'dir', count: 12 },
        { dir: join(pkg, 'nowhere'), state: 'missing', count: 0 },
      ],
      roles: [],
    }, '/nonexistent-proj');
    assert.match(zero, /0 个/, zero);
    assert.match(zero, /试过/, zero);
    assert.match(zero, /存在但不是目录/, `把「是文件」说成了别的：${zero}`);
    assert.match(zero, /12 个角色/, `把「有 12 个角色」说成「不存在或为空」= 假话：${zero}`);
    assert.match(zero, /不存在/, zero);
    assert.ok(!/都不存在或为空/.test(zero), `还在用那句一刀切的假话：${zero}`);
    assert.ok(!zero.includes(pkg), `泄漏了绝对路径：${zero}`);
  } finally { rmSync(pkg, { recursive: true, force: true }); }

  // 项目分支：仍然相对 root 打印
  const d = makeProject({ agents: { qa: { name: 'qa' } } });
  try {
    const proj = sourceText(rolesFor(d), d);
    assert.match(proj, /项目角色目录 \.\/\.claude\/agents（1 个）/, proj);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('DF-062 整改① displayPath：三级回落，任何一级都不吐绝对前缀', () => {
  const root = join(tmpdir(), 'ow-dp-proj');
  // 1) 在 root 底下 → `./…`（最可执行）
  assert.equal(displayPath(join(root, '.claude', 'agents'), root), './.claude/agents');
  // 2) 在框架包根底下 → `<pkg>/…`。载荷形态走的就是这一级：
  //    root 是用户项目，角色在载荷里，相对 root 会是 `../../…` 那种看不懂的串。
  assert.equal(displayPath(join(REPO, 'agents'), root), '<pkg>/agents');
  assert.equal(displayPath(join(REPO, '.claude', 'agents'), root), '<pkg>/.claude/agents');
  // 3) 都不在 → `<abs>/…`，保留最后两段（足够区分两个候选）
  const other = join(tmpdir(), 'ow-dp-elsewhere', '.claude', 'agents');
  assert.equal(displayPath(other, root), '<abs>/.claude/agents');
  assert.equal(displayPath(join(tmpdir(), 'ow-dp-elsewhere', 'agents'), root), '<abs>/ow-dp-elsewhere/agents');
  // 假值不许拼出相对路径
  assert.equal(displayPath(''), '(无)');
  assert.equal(displayPath(null), '(无)');
  // 相对的「候选」不参与推断：没有本机前缀可遮，原样打印
  assert.equal(displayPath('agents', root), 'agents');
});

test('DF-062 整改④：`<pkg>/.claude/agents` 是**普通文件**时不许崩栈', () => {
  const pkg = tmp();
  try {
    mkdirSync(join(pkg, '.claude'), { recursive: true });
    writeFileSync(join(pkg, '.claude', 'agents'), '我不是目录');
    mkdirSync(join(pkg, 'agents'), { recursive: true });
    writeFileSync(join(pkg, 'agents', 'oversight-qa.md'), agentMd({ name: 'oversight-qa' }));

    // 探测阶段不许抛，且要认出另一个候选里的角色
    assert.equal(agentsDir(pkg), join(pkg, 'agents'), '一个文件把候选占了；修前这里会 ENOTDIR 崩栈');
    const probe = probeAgentsDir(pkg);
    assert.deepEqual(probe.tried.map((t) => t.state), ['notdir', 'dir']);

    // `discoverRoles` 的契约是「扫不出来就返回 []」，不是「抛」。直接喂那个文件：
    assert.deepEqual(discoverRoles(join(pkg, '.claude', 'agents')), [],
      'ENOTDIR 没被兜住 —— 契约写着「目录不存在时返回 []」，那「存在但不是目录」更不能抛栈');
  } finally { rmSync(pkg, { recursive: true, force: true }); }
});

// ── DF-062 整改⑤：配置坏了（候选不是目录）必须说出来，**哪怕最终拿到 12 个角色** ──
//
// 评审打回的那条。修前实测形态：
//
//   <pkg>/.claude/agents 是普通文件，<pkg>/agents 有 12 个角色
//   → 「框架角色目录 <pkg>/agents（12 个）」、一个字都不提那个坏掉的目录
//
// 用户去建 `.claude/agents` 说明他**想用那个位置**；他往里加角色会发现「加了没反应」。
// 这是本仓台账最高频的缺陷形态：**配置坏了但看起来一切正常**。
// 噪音边界同样是判据的一部分：正常形态（目录正常 / 根本没建）**一个字都不许多**。

test('DF-062 整改⑤：候选「存在但不是目录」时，角色数再正常也必须报出来', () => {
  const pkg = tmp();
  try {
    // —— 框架侧：坏掉的 .claude/agents + 正常的 agents/（12 个的机会，这里用 1 个代表）——
    mkdirSync(join(pkg, '.claude'), { recursive: true });
    writeFileSync(join(pkg, '.claude', 'agents'), '我不是目录');
    mkdirSync(join(pkg, 'agents'), { recursive: true });
    writeFileSync(join(pkg, 'agents', 'oversight-qa.md'), agentMd({ name: 'oversight-qa' }));

    const probe = probeAgentsDir(pkg);
    assert.equal(probe.roles.length, 1, '前提：另一个候选里确有角色（否则这条测不到「成功了也要报」）');
    assert.deepEqual(probe.warnings, [{
      code: 'notdir', scope: 'framework', dir: join(pkg, '.claude', 'agents'), chosen: join(pkg, 'agents'),
    }], '探测没带出 notdir warning —— 坏配置会继续隐身');

    const text = sourceText({
      source: 'framework', dir: probe.dir, tried: probe.tried, warnings: probe.warnings,
      roles: probe.roles,
    }, '/nonexistent-proj');
    assert.match(text, /（1 个/, text);
    assert.match(text, /⚠/, `有角色就闭眼不报坏目录 —— 配置坏了却看起来正常：${text}`);
    assert.match(text, /存在但不是目录/, text);
    assert.match(text, /不会被读到/, `没告诉用户「往里放角色没用」这个后果：${text}`);
    assert.match(text, /<abs>\/\.claude\/agents/, `没说清哪个目录坏了：${text}`);
    assert.ok(!text.includes(pkg), `泄漏了绝对路径：${text}`);

    // —— 项目侧：用户项目里 `.claude/agents` 是文件 ——
    // 此时**不能**再说「用户项目里没有 .claude/agents/」：它有，只是坏了。
    const proj = tmp();
    try {
      mkdirSync(join(proj, '.claude'), { recursive: true });
      writeFileSync(join(proj, '.claude', 'agents'), '我不是目录');
      const s = rolesFor(proj);
      assert.equal(s.source, 'framework', '前提：项目分支拿不到角色，回落到框架');
      const projWarn = (s.warnings || []).find((w) => w.scope === 'project');
      assert.ok(projWarn, '项目里那个坏目录没进 warnings —— 用户会以为「项目没建」而不是「建坏了」');
      assert.equal(projWarn.dir, join(proj, '.claude', 'agents'));
      const t = sourceText(s, proj);
      assert.match(t, /⚠ 项目角色目录/, t);
      assert.match(t, /存在但不是目录/, t);
      assert.ok(!/用户项目里没有 \.claude\/agents\//.test(t),
        `同时说「用户项目里没有」和「项目角色目录坏了」—— 自相矛盾：${t}`);
    } finally { rmSync(proj, { recursive: true, force: true }); }
  } finally { rmSync(pkg, { recursive: true, force: true }); }

  // —— 噪音边界：一切正常时一个字符都不多 ——
  const ok = probeAgentsDir(REPO);
  assert.deepEqual(ok.warnings, [], '本仓的正常形态产生了 warning —— 每次输出都会多一句噪音');
  const okText = sourceText(rolesFor(null), REPO);
  assert.ok(!/⚠/.test(okText), `正常形态不该有 ⚠：${okText}`);
  assert.ok(!/不会被读到/.test(okText), okText);
  // 空目录（存在、是目录、只是没角色）不是「坏配置」，不许报
  const emptyPkg = tmp();
  try {
    mkdirSync(join(emptyPkg, '.claude', 'agents'), { recursive: true });
    assert.deepEqual(probeAgentsDir(emptyPkg).warnings, [],
      '空目录被当成了坏配置 —— 那是正常形态（用户建了目录还没放角色）');
  } finally { rmSync(emptyPkg, { recursive: true, force: true }); }
});

// ── DF-062 整改③：默认参数必须**可被证伪** ──────────────────────────────
//
// 红队实测：把 `discoverRoles(dir = agentsDir())` 改回模块常量
// `resolve(HERE,'..','.claude','agents')`，`node --test scripts/` 仍然 1919 全绿。
// 也就是「这次修复有一半改动没有任何测试守着」—— 默认参数是模块求值时机问题，
// 任何**进程内** import 都证明不了它（那正是缺陷本身），所以必须是：
//   · 真造一个「只有 `agents/` 布局」的包根（把 roles.mjs 拷进 `<pkg>/scripts/`）；
//   · **零参**调用 `discoverRoles()` / `defaultRoles()`；
//   · 在真子进程里跑（`import.meta.url` 由文件位置决定，进程内伪造不了）。
// 这样改回常量时：`<pkg>/.claude/agents` 不存在 → 0 个角色 → 这条必红。

test('DF-062 整改③：零参 discoverRoles() / defaultRoles() 必须跟着**包根**走，不是模块常量', () => {
  const pkg = tmp();
  try {
    mkdirSync(join(pkg, 'scripts'), { recursive: true });
    mkdirSync(join(pkg, 'agents'), { recursive: true });
    writeFileSync(join(pkg, 'agents', 'oversight-qa.md'), agentMd({ name: 'oversight-qa' }));
    writeFileSync(join(pkg, 'agents', 'oversight-planner.md'), agentMd({ name: 'oversight-planner' }));
    writeFileSync(join(pkg, 'scripts', 'roles.mjs'), readFileSync(join(HERE, 'roles.mjs')));
    // 前提钉住：这个包根**没有** `.claude/agents` —— 改回常量就等于指向一个不存在的目录
    assert.ok(!existsSync(join(pkg, '.claude', 'agents')), '夹具里出现了 .claude/agents，这条用例就测不到默认参数了');

    const url = pathToFileURL(join(pkg, 'scripts', 'roles.mjs')).href;
    const script = [
      `import { discoverRoles, defaultRoles, agentsDir } from ${JSON.stringify(url)};`,
      'console.log(JSON.stringify({',
      '  dir: agentsDir(),',
      '  zeroArg: discoverRoles().map((r) => r.id).sort(),',
      '  defaults: defaultRoles().map((r) => r.id).sort(),',
      '}));',
    ].join('\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, `零参调用崩了：\n${r.stdout}${r.stderr}`);
    const got = JSON.parse(String(r.stdout).trim());
    const want = ['planner', 'qa'];
    assert.equal(got.dir, join(pkg, 'agents'), `agentsDir() 没跟着包根走：${got.dir}`);
    assert.deepEqual(got.zeroArg, want,
      '`discoverRoles()` 的默认参数退回成模块常量了 —— 它在载荷形态下指向不存在的 .claude/agents');
    assert.deepEqual(got.defaults, want,
      '`defaultRoles()` 的默认参数退回成模块常量了 —— 同上，且它还是三处消费的锚点');
  } finally { rmSync(pkg, { recursive: true, force: true }); }
});

test('端到端：validate-run 在别人的项目里按**项目的**角色表判', () => {
  // 这一条是 D2 场景的最小复现，必须跑真子进程 —— 缺陷的形态就是
  // 「模块加载时求值」，在任何进程内调用里都看不出来（import 发生在 --root 之前）。
  const d = makeProject({ agents: { qa: { name: 'qa' }, reviewer: { name: 'reviewer' } } });
  try {
    // .git 让 projectRoot 的阶梯第 4 级认得出它
    spawnSync('git', ['init', '-q', '.'], { cwd: d, encoding: 'utf8' });
    const g = (cap) => join(d, `g-${cap}.json`);
    const mk = (cap) => {
      writeFileSync(g(cap), JSON.stringify({
        run_id: 'r1', root_goal: '目标', constraints: [],
        subtrees: [{
          id: 'ST1', goal: '做点事', capability: cap, shape: 'artifact',
          token_budget_pct: 20, timeout_min: 10, parallel_with: [], depends_on: [],
          acceptance: [{ id: 'AC1', criterion: 'a.md:1 有东西', evidence: 'a.md:1', fail_if: '没有' }],
          outputs: ['a.md'], why_this_layer: 'w',
        }],
      }), 'utf8');
      return g(cap);
    };

    const cli = join(REPO, 'scripts', 'validate-run.mjs');
    const run = (cap) => spawnSync(process.execPath, [cli, '--simple', mk(cap)], { encoding: 'utf8' });

    const ok = run('qa');
    assert.equal(ok.status, 0, `项目里真有 qa，却判非法（缺陷 1 的原形）：\n${ok.stdout}${ok.stderr}`);
    assert.match(ok.stderr, /角色表 → 项目角色目录/, `没有打印角色表来源：\n${ok.stderr}`);

    // **反向**：项目里不存在的角色必须被拒。修前这一条 exit 0（框架有 executor），
    // 于是「校验通过」不再意味着「这个角色在项目里存在」—— 比不校验更糟。
    const bad = run('executor');
    assert.equal(bad.status, 1, `项目里没有 executor，却放行了：\n${bad.stdout}${bad.stderr}`);
    assert.match(bad.stdout, /executor" 不在合法取值内（qa \/ reviewer）/, bad.stdout);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ── DF-062 端到端：真生成一份载荷，在外部项目里跑它 ──────────────────────
//
// 这一条**必须 spawn 真子进程 + 真载荷目录**，不能用进程内 import 伪造：
// 载荷形态的本质是「脚本的物理位置在 `<payload>/scripts`」，而 `import.meta.url`
// 由文件位置决定，进程内无法伪造。同 DF-062 的原始复现路径一致。

test('DF-062 端到端：载荷形态（<payload>/agents）下 validate-run 认到全部角色', () => {
  const src = tmp();
  const out = join(src, 'payload');
  const proj = tmp();
  try {
    // 1) 从本仓真生成一份载荷
    const b = spawnSync(process.execPath, [join(REPO, 'scripts', 'build-payload.mjs'), '--out', out],
      { cwd: REPO, encoding: 'utf8' });
    assert.equal(b.status, 0, `载荷生成失败：\n${b.stdout}${b.stderr}`);
    assert.ok(existsSync(join(out, 'agents', 'oversight-planner.md')), '载荷里没有 agents/*.md');
    assert.ok(existsSync(join(out, 'scripts', 'validate-run.mjs')), '载荷里没有 scripts/（DF-060 复发）');
    // 前提钉住：载荷里**不该**有 .claude/agents —— 那会让这条用例测不到探测顺序
    assert.ok(!existsSync(join(out, '.claude', 'agents')),
      '载荷里出现了 .claude/agents/ —— 这条用例就不再是「载荷形态」了');

    // 2) 外部项目：只有一个 README + git，没有任何角色定义
    writeFileSync(join(proj, 'README.md'), '# 外部项目\n');
    spawnSync('git', ['init', '-q', '.'], { cwd: proj, encoding: 'utf8' });

    // 3) 跑载荷里的 validate-run（--help 之前就会打印角色表）
    const r = spawnSync(process.execPath, [join(out, 'scripts', 'validate-run.mjs'), '--help'],
      { cwd: proj, encoding: 'utf8' });
    const text = `${r.stdout}${r.stderr}`;
    assert.match(text, /角色表 → 框架角色目录/, text);
    assert.ok(!/（0 个/.test(text), `载荷形态下角色表是空的 —— DF-062 原样复发：\n${text}`);
    // **不钉死总数**：角色数会变（2026-11-23 加了 verifier）。判据是「非零」——
    // 上一行已经否掉了「（0 个」，这里再要求读得到一个数字。
    assert.match(text, /（\d+ 个/, text);
    assert.match(text, /框架角色目录 .*agents/, `来源没指向 <payload>/agents：\n${text}`);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('端到端：compose 用项目的角色 + 项目的 agentPrefix，模板仍走框架', () => {
  // 三个缺陷一次性验完：角色根（2）、前缀（3）、模板根（2 的后半）。
  // 修前：不给 --root → 读框架角色 → 「没有这个角色的定义」；
  //       给 --root . → 角色对了，但项目里没有 templates/dispatch.md → L1 exit 1。
  const d = makeProject({
    agents: { 'ow-qa': { name: 'ow-qa', display: '质量', tools: 'Read, Write, Bash', readonly: false } },
    config: { agent: { agentPrefix: 'ow-' } },
  });
  try {
    spawnSync('git', ['init', '-q', '.'], { cwd: d, encoding: 'utf8' });
    const runDir = join(d, '.untildone', 'runs', 'r1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'task-graph.json'), JSON.stringify({
      run_id: 'r1', root_goal: '目标', constraints: [],
      subtrees: [{
        id: 'ST1', goal: '对交付物逐项判定，按预声明标准给出通过或不通过与证据引用',
        capability: 'qa', shape: 'artifact', token_budget_pct: 20, timeout_min: 10,
        parallel_with: [], depends_on: [],
        acceptance: [{ id: 'AC1', criterion: '`node scripts/x.mjs` 全绿', evidence: '命令输出', fail_if: 'exit!=0' }],
        outputs: ['a.md'], why_this_layer: 'w',
      }],
    }), 'utf8');

    const cli = join(REPO, 'scripts', 'compose-agent-prompt.mjs');
    const r = spawnSync(process.execPath, [cli, 'compose', '--run', 'r1', '--task', 'ST1',
      '--role', 'qa', '--stop', '10 分钟内返回', '--dry-run'], { cwd: d, encoding: 'utf8' });
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(!/没有这个角色的定义/.test(out), `项目里的 qa 仍然解析不到：\n${out}`);
    assert.match(out, /前缀 "ow-"/, `没有用项目的 agentPrefix：\n${out}`);
    // L1 模板来自框架：项目里没有 templates/，但不应因此报错
    assert.ok(!/L1: 读不到 templates\/dispatch\.md/.test(out),
      `模板仍然走项目根（缺陷 2 的后半）：\n${out}`);
    assert.equal(r.status, 0, out);
  } finally { rmSync(d, { recursive: true, force: true }); }
});


// ── DF-064：「角色在哪」只有一套答案 ──────────────────────────────────
//
// 修前有三套：`checks.json` 的 `agentsDir`（硬门用）、`roles.mjs` 的
// `agentsDirCandidates()` / `rolesDirFor()`（运行期用）、宿主自己加载的
// `<项目根>/.claude/agents/`。三者可以各不相同，而**没有一个机制发现它们分叉了**。
//
// 修法不是「让 roles.mjs 也读 checks.json」（那是给「角色在哪」添第二个真源，
// 而两份真源必然漂 —— 本仓为这件事付过账：DF-013/044/062）。修法是**删掉一个真源**：
//   · `checks.json` 不再有 `agentsDir` 这个键（写进配置就是「未知的键」错误）；
//   · 硬门的 `AGENTS_DIR` 从 `rolesDirFor(ROOT)` 取，不再自己拼；
//   · `rolesDirFor()` 恒等于 `<根>/.claude/agents` —— 与宿主加载项目角色的路径**同一个**。
// 剩下的唯一真源是 `rolesDirFor()`，它是纯路径拼接，没有「探测」「候选」这些分支。
//
// 下面两条钉住这个结论的可判定形态：配置键不存在，且三者指向同一个字符串。

test('DF-064「角色在哪」只有一套答案：checks.json 不再接受 agentsDir 键', () => {
  const v = validateChecks({ agentsDir: 'team/agents' });
  assert.equal(v.ok, false,
    'agentsDir 仍是合法配置键 —— 那意味着「角色在哪」又有两套答案（DF-064 原样复发）');
  assert.ok(v.errors.some((e) => e.path === 'agentsDir' && /未知的键/.test(e.msg)),
    `agentsDir 必须以「未知的键」被拒（配置坏了要当场报，不静默回落）：${JSON.stringify(v.errors)}`);
});

test('DF-064 硬门的 AGENTS_DIR 与运行期的 rolesDirFor() 是同一个字符串', () => {
  // 硬门不是模块（一 import 就跑完全部门禁并 exit），所以从源码读它的取法。
  // 判据必须是「它**没有**自己的答案」，不是「它提到了 rolesDirFor」——
  // 后者能被注释骗过（本仓已吃过 `src.includes('X(')` 的亏）。
  const src = readFileSync(join(REPO, 'scripts', 'check-structure.mjs'), 'utf8');
  assert.match(src, /const AGENTS_DIR = rolesDirFor\(ROOT\)/,
    '硬门的 AGENTS_DIR 不是从 rolesDirFor() 取的 —— 它又有了自己的答案（DF-064）');
  assert.ok(!/CFG\.agentsDir/.test(src),
    '硬门仍在读 CFG.agentsDir —— 那个键已经删了，这一行会永远拿到 undefined');
  // 运行期那一侧：`rolesDirFor(root)` 恒等于 `<root>/.claude/agents`，与宿主加载
  // 项目角色的路径逐字相同。这条同时证明「三者同一个」的第三项。
  assert.equal(rolesDirFor('/proj'), join('/proj', '.claude', 'agents'));
});
