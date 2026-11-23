#!/usr/bin/env node
/**
 * forbidden-override.test.mjs — frontmatter 的 `forbiddenContext` 覆盖**真的生效**（DF-079）。
 *
 * ## 它守的是什么
 *
 * `scripts/roles.mjs` 的 `FORBIDDEN_CONTEXT` 上方写着「角色也可以在 frontmatter 写
 * `forbiddenContext: a, b` 覆盖它」。注册表**确实**读到了这个字段
 * （`discoverRoles()` 返回的 `role.forbiddenContext` 是对的）。但修前
 * `checkPromptSpec` 直接查冻结表 `FORBIDDEN_BY_ID[roleId]`，于是**覆盖没有任何调用方消费**。
 *
 * 实测症状（2026-11-22，临时项目 + 一份 `oversight-executor.md` 副本，
 * 往 frontmatter 加 `forbiddenContext: self_assessment`）：
 *
 *     注册表 executor.forbiddenContext = ["self_assessment"]
 *     compose independence = true | 该角色无额外禁止项      ← 覆盖没生效
 *
 * 后果是**配置坏了但看起来一切正常**：项目以为自己加了一道闸，而那道闸没接线。
 * 这与本仓台账里最高频的缺陷形态同形。
 *
 * ## 为什么必须跑真 CLI
 *
 * 只测 `checkPromptSpec({ ... })` 的话，把 CLI 改回「不传 roles」它照样绿
 * —— 而那正是缺陷 B（`context` 恒传 `{}`）的同一形态：**判据在，没人喂它**。
 * 所以这一份的判据全部落在 spawn 出来的 CLI 的退出码上。
 *
 * ## 负向验证（本节的核心）
 *
 * 正向：给 executor 的 frontmatter 加覆盖 → `independence` 判 ✗、exit 1。
 * 反向：**去掉**覆盖 → 同样的输入 → `independence` 判 ✓、exit 0。
 * 两条缺一条都不成立：「永远拒绝」也能让正向变绿。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 顶层 import：`roles.mjs` 只读盘、无副作用。写在用例体里 `return import(...)` 会让
// `finally` 的 rmSync 在 promise 解析前就把目录删掉 —— 第一版正是这么红的。
import { discoverRoles } from './roles.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI = join(ROOT, 'scripts', 'compose-agent-prompt.mjs');
const EXECUTOR_SRC = join(ROOT, '.claude', 'agents', 'oversight-executor.md');

/** 造一个「项目」：它自己的 `.claude/agents/` + `.untildone/`（项目根标记）+ 一份 task-graph。
 *
 *  `.untildone/` 是 `projectRoot()` 阶梯的第 4 级标记；不给它，compose 会停在
 *  「找不到用户项目根」并 exit 2 —— 那条路与本用例无关，会掩盖真正要测的判据。 */
function makeProject(dir, { executorFrontmatter = '' } = {}) {
  const agents = join(dir, '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  mkdirSync(join(dir, '.untildone'), { recursive: true });
  writeFileSync(join(dir, '.untildone', 'checks.json'), '{}\n', 'utf8');

  // 从真身复制，只在 frontmatter 的收尾 `---` 之前插一行。
  // **复制真身而不是手写样本**：手写的样本改坏了也没人知道，而真身改了会红在别处。
  const src = readFileSync(EXECUTOR_SRC, 'utf8');
  const i = src.indexOf('\n---', 3);
  const body = i > 0 ? src.slice(0, i) + (executorFrontmatter ? `\n${executorFrontmatter}` : '') + src.slice(i) : src;
  writeFileSync(join(agents, 'oversight-executor.md'), body, 'utf8');

  const runDir = join(dir, 'tasks', 'runs', 'r1');
  mkdirSync(runDir, { recursive: true });
  const graph = join(runDir, 'task-graph.json');
  writeFileSync(graph, JSON.stringify({
    run_id: 'r1', root_goal: '验证', constraints: [],
    subtrees: [{
      id: 'ST1', goal: '实现扫描器并把结果写到文件，跑通回归测试', capability: 'executor',
      shape: 'artifact', token_budget_pct: 20, timeout_min: 25,
      parallel_with: [], depends_on: [],
      acceptance: [{ id: 'AC1', criterion: '`node scripts/check-structure.mjs` 全绿', evidence: '命令输出', fail_if: 'exit != 0' }],
      outputs: ['tasks/runs/r1/verdict.md'],
      why_this_layer: '实现必须有一个写代码的手',
    }],
  }), 'utf8');

  const ctx = join(dir, 'ctx.json');
  writeFileSync(ctx, JSON.stringify({ self_assessment: '我做了 90%，剩下的是小事' }), 'utf8');
  return { graph, ctx, dir };
}

/** 跑 compose，返回 `{status, out, check(`id`)}`。`--dry-run` 不落文件，所以不留垃圾。
 *  `role` 默认 executor —— 三个用例都是围绕「执行者没有额外禁止项」这个前提设计的；
 *  验收那两条显式传 `'acceptor'`。 */
function compose(dir, graph, ctx, role = 'executor') {
  const r = spawnSync(process.execPath, [
    CLI, 'compose', '--run', 'r1', '--task', 'ST1', '--graph', graph, '--role', role,
    '--stop', '20 分钟内返回，每项产出带 file:line',
    '--context-from', ctx, '--dry-run', '--root', dir,
  ], { encoding: 'utf8', timeout: 60000 });
  const out = `${r.stdout}${r.stderr}`;
  /** 取某一项检查那一行（`✓ id — …` / `✗ id — …`）。找不到时返回 null。 */
  const check = (id) => {
    const m = out.match(new RegExp(String.raw`^  [✓✗] ${id}(?: — .*)?$`, 'm'));
    return m ? m[0] : null;
  };
  return { status: r.status, out, check };
}

// ── 正向：覆盖生效 ─────────────────────────────────────────────────────

test('正向：executor 的 frontmatter 加 forbiddenContext: self_assessment → independence 判 ✗', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-ovr-'));
  try {
    const p = makeProject(dir, { executorFrontmatter: 'forbiddenContext: self_assessment' });
    const r = compose(p.dir, p.graph, p.ctx);
    const ind = r.check('independence');
    assert.ok(ind, `没有 independence 那一行：\n${r.out}`);
    assert.match(ind, /✗/, `覆盖没生效 —— independence 仍判通过：${ind}\n${r.out}`);
    assert.match(ind, /self_assessment/, '报错没点名被注入的那一项');
    assert.equal(r.status, 1, `覆盖生效时必须拒绝派发（exit 1）：\n${r.out}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('正向：覆盖是**替换**不是合并 —— 只写一项时，冻结表里的其他项不再拦', () => {
  // `roles.mjs` 的注释写着「覆盖而非合并：合并会让『删掉一项』变得不可表达」。
  // 这条判据证明实现真的按那个语义走：给 acceptor 写一条覆盖，它的
  // `review_score` 禁止项应当**消失**（覆盖掉了），于是注入 review_score 能通过。
  const dir = mkdtempSync(join(tmpdir(), 'ow-ovr-'));
  try {
    const agents = join(dir, '.claude', 'agents');
    mkdirSync(agents, { recursive: true });
    mkdirSync(join(dir, '.untildone'), { recursive: true });
    writeFileSync(join(dir, '.untildone', 'checks.json'), '{}\n', 'utf8');
    // 只读角色不能带 Bash/Edit —— 按 acceptor 的工具形状手写一份最小定义。
    writeFileSync(join(agents, 'oversight-acceptor.md'), [
      '---',
      'name: oversight-acceptor',
      'description: 测试用验收角色，正文无所谓，只要 frontmatter 完整。',
      'tools: Read, Grep, Glob, Write',
      'readonly: true',
      'display: 验收',
      // 覆盖成只剩一项：`review_score` 不在里面了。
      'forbiddenContext: self_assessment',
      '---',
      '',
      '正文。只允许写报告。',
      '',
    ].join('\n'), 'utf8');

    const runDir = join(dir, 'tasks', 'runs', 'r1');
    mkdirSync(runDir, { recursive: true });
    const graph = join(runDir, 'task-graph.json');
    writeFileSync(graph, JSON.stringify({
      run_id: 'r1', root_goal: '验证', constraints: [],
      subtrees: [{
        id: 'ST1', goal: '对交付物逐项判定，按预声明标准给出通过或不通过与证据引用',
        capability: 'acceptor', shape: 'artifact', token_budget_pct: 20, timeout_min: 25,
        parallel_with: [], depends_on: [],
        acceptance: [{ id: 'AC1', criterion: '`node scripts/check-structure.mjs` 全绿', evidence: '命令输出', fail_if: 'exit != 0' }],
        outputs: ['tasks/runs/r1/verdict.md'],
        why_this_layer: '验收必须由不写稿的一方做',
      }],
    }), 'utf8');
    const ctx = join(dir, 'ctx.json');
    writeFileSync(ctx, JSON.stringify({ review_score: 8 }), 'utf8');

    const r = compose(dir, graph, ctx, 'acceptor');
    const ind = r.check('independence');
    assert.ok(ind, `没有 independence 那一行：\n${r.out}`);
    assert.match(ind, /✓/, `覆盖没生效 —— review_score 仍被冻结表拦下：${ind}\n${r.out}`);
    assert.match(ind, /self_assessment/, '通过时的理由没说明用的是哪一份清单');
    assert.match(ind, /注册表/, `通过的理由没说明来源是注册表（覆盖生效的唯一证据）：${ind}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 反向：去掉覆盖 → 同样的输入必须通过 ────────────────────────────────

test('反向：去掉覆盖后，同样的 self_assessment 输入必须通过（否则这是「永远拒绝」）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-ovr-'));
  try {
    const p = makeProject(dir, { executorFrontmatter: '' });
    const r = compose(p.dir, p.graph, p.ctx);
    const ind = r.check('independence');
    assert.ok(ind, `没有 independence 那一行：\n${r.out}`);
    assert.match(ind, /✓/, `去掉覆盖后仍拒绝 —— 这条判据不是「读覆盖」，是「永远红」：${ind}\n${r.out}`);
    assert.match(ind, /该角色无额外禁止项/, ind);
    assert.equal(r.status, 0, `去掉覆盖后应当放行（exit 0）：\n${r.out}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 冻结表在注册表记录缺失时仍然生效（不能为了修覆盖把原能力弄坏）──────────

test('对照组：acceptor 不写覆盖时，冻结表里的 review_score 仍然拦得住', () => {
  // 修 DF-079 最容易犯的错是「改成只读注册表」—— 那样任何**没写** forbiddenContext 的
  // 角色都会拿到空清单（注册表对缺省角色返回 `[]`），于是冻结表整张失效。
  // 冻结表必须继续在「记录存在但没有覆盖」时被用上 —— 这条用例守的就是那个缺省。
  const dir = mkdtempSync(join(tmpdir(), 'ow-ovr-'));
  try {
    const agents = join(dir, '.claude', 'agents');
    mkdirSync(agents, { recursive: true });
    mkdirSync(join(dir, '.untildone'), { recursive: true });
    writeFileSync(join(dir, '.untildone', 'checks.json'), '{}\n', 'utf8');
    writeFileSync(join(agents, 'oversight-acceptor.md'), [
      '---',
      'name: oversight-acceptor',
      'description: 测试用验收角色，正文无所谓，只要 frontmatter 完整。',
      'tools: Read, Grep, Glob, Write',
      'readonly: true',
      'display: 验收',
      '---',
      '',
      '正文。只允许写报告。',
      '',
    ].join('\n'), 'utf8');

    const runDir = join(dir, 'tasks', 'runs', 'r1');
    mkdirSync(runDir, { recursive: true });
    const graph = join(runDir, 'task-graph.json');
    writeFileSync(graph, JSON.stringify({
      run_id: 'r1', root_goal: '验证', constraints: [],
      subtrees: [{
        id: 'ST1', goal: '对交付物逐项判定，按预声明标准给出通过或不通过与证据引用',
        capability: 'acceptor', shape: 'artifact', token_budget_pct: 20, timeout_min: 25,
        parallel_with: [], depends_on: [],
        acceptance: [{ id: 'AC1', criterion: '`node scripts/check-structure.mjs` 全绿', evidence: '命令输出', fail_if: 'exit != 0' }],
        outputs: ['tasks/runs/r1/verdict.md'],
        why_this_layer: '验收必须由不写稿的一方做',
      }],
    }), 'utf8');
    const ctx = join(dir, 'ctx.json');
    writeFileSync(ctx, JSON.stringify({ review_score: 8 }), 'utf8');

    const r = compose(dir, graph, ctx, 'acceptor');
    const ind = r.check('independence');
    assert.ok(ind, `没有 independence 那一行：\n${r.out}`);
    assert.match(ind, /✗/, `没写覆盖时冻结表失效了 —— 验收拿到了锐评分数：${ind}\n${r.out}`);
    assert.match(ind, /review_score/, ind);
    assert.equal(r.status, 1, r.out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 回退断言：注册表不能从 spec 里被悄悄摘掉 ─────────────────────────────

test('回退：CLI 不再把 roles 传进 spec → 覆盖立刻失效（这条判据必须变红）', () => {
  // 这是整个修复的接线点：`checkPromptSpec` 读 `spec.roles`。把它从 CLI 里删掉，
  // 函数层仍能回落到 `defaultRoles()`（框架注册表）—— 而项目的覆盖就再也到不了。
  //
  // 用**变异副本**跑真进程，不改磁盘上的真身（改真身会让中途 assert 失败时仓库留在坏状态）。
  const dir = mkdtempSync(join(tmpdir(), 'ow-ovr-mut-'));
  try {
    const src = readFileSync(CLI, 'utf8');
    // 锚点必须唯一，否则「改坏的其实是别处」。
    const anchor = '      roles,\n';
    assert.equal(src.split(anchor).length - 1, 1, '源码里 `roles,` 那一行应当唯一');
    const mutated = src.replace(anchor, '      // 回退：不传注册表\n');
    const target = join(ROOT, 'scripts', `.neg-ovr-${process.pid}.mjs`);
    writeFileSync(target, mutated, 'utf8');
    try {
      const p = makeProject(dir, { executorFrontmatter: 'forbiddenContext: self_assessment' });
      const r = spawnSync(process.execPath, [
        target, 'compose', '--run', 'r1', '--task', 'ST1', '--graph', p.graph, '--role', 'executor',
        '--stop', '20 分钟内返回，每项产出带 file:line',
        '--context-from', p.ctx, '--dry-run', '--root', p.dir,
      ], { encoding: 'utf8', timeout: 60000 });
      const out = `${r.stdout}${r.stderr}`;
      const ind = out.match(/^  [✓✗] independence(?: — .*)?$/m);
      assert.ok(ind, `没有 independence 那一行：\n${out}`);
      // 回退后的表现就是缺陷原样：exit 0 + 「该角色无额外禁止项」。
      assert.equal(r.status, 0, `删掉传参后仍然拒绝了 —— 判据不是靠 spec.roles 生效的：\n${out}`);
      assert.match(ind[0], /✓/);
      assert.match(ind[0], /该角色无额外禁止项/);
    } finally { rmSync(target, { force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 注册表层：覆盖值本身要被读出来（不是只有 CLI 一层）─────────────────

test('注册表层：executor 写了覆盖后，discoverRoles 返回的就是覆盖后的值', () => {
  // 这一条与 CLI 那条不是重复：它证明**数据的来源**是对的。
  // 只测 CLI 的话，把 `discoverRoles` 对 forbiddenContext 的读取删掉、再在
  // CLI 里补一个同样的解析，两条都会绿 —— 而「唯一实现」就没了。
  const dir = mkdtempSync(join(tmpdir(), 'ow-ovr-reg-'));
  try {
    const agents = join(dir, 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'ow-x.md'), [
      '---',
      'name: ow-x',
      'description: 测试用的角色定义，正文无所谓，只要 frontmatter 完整。',
      'tools: Read, Grep',
      'readonly: true',
      'forbiddenContext: alpha, beta',
      '---',
      '',
      '正文。',
      '',
    ].join('\n'), 'utf8');
    // 顶层 import 的 `discoverRoles`（`roles.mjs` 只读盘、无副作用）。
    const roles = discoverRoles(agents, { agentPrefix: 'ow-' });
    const r = roles.find((x) => x.id === 'x');
    assert.ok(r, `没扫到 ow-x：${JSON.stringify(roles)}`);
    assert.deepEqual(r.forbiddenContext, ['alpha', 'beta'],
      `frontmatter 的覆盖没有被读成数组：${JSON.stringify(r.forbiddenContext)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
