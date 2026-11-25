#!/usr/bin/env node
/**
 * delivery-verdict-wiring.test.mjs — 「交付裁决」有没有真的接进链路（DF-080）。
 *
 * ## 为什么这一份必须存在
 *
 * `delivery-verdict.test.mjs` 有 39 条用例，全部对着纯函数跑。它们证明的是
 * 「裁决算得对」，**不证明「有人调用它」**。2026-11-22 审计的实测结论是：
 * `grep -rn "delivery-verdict" scripts/` 只命中它自己、它的测试、以及硬门的两处登记
 * —— 零个生产路径 import 它。
 *
 * 这与 DF-042 是同一个形态：**定义里写得再对，没人调用等于不存在。**
 * 一个没有调用点的门，与不存在同形。
 *
 * ## 这一份测什么（两件事，缺一不可）
 *
 *   1. **SKILL.md 的 Phase E 段内**真的调用它 —— 不是「文件里某处提了一句」。
 *      判据落在 Phase E 那一段上，因为裁决必须发生在「验收与失败处理」那一步；
 *      写在附录里等于没接。
 *   2. **CLI 能跑通一个真实输入**，且退出码就是裁决本身：
 *      「验收 PASS + 红队 block」→ exit 2（BLOCKED），「验收不通过」→ exit 1（FAILED），
 *      「文件读不到」→ exit 3（不是 0 —— 读不到不等于通过）。
 *
 * 第 2 条必须 spawn 真进程 + 真文件：进程内调 `main()` 会漏掉「入口守卫写错导致
 * 静默 exit 0」这一整类失效（`entry-symlink.test.mjs` 记的正是这个）。
 *
 * ## 每条都配回退断言
 *
 * 只断言「现在有」的测试挡不住下次重构。这里对 SKILL 那一处真的做一次字符串删改
 * 再断言判据变假 —— 删的是本文件自己造出来的副本，不改磁盘上的真文件。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 直接 import 纯函数。模块有「我是不是被直接执行」的入口守卫，import 无副作用。
import { parseRedteamReport, deviationRefsFrom } from './delivery-verdict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const SKILL = '.claude/skills/oversight/SKILL.md';
const CLI = join(ROOT, 'scripts', 'delivery-verdict.mjs');

/** 从 SKILL.md 里取出 Phase E 那一段（到 Phase F 之前）。
 *
 *  只断言「文件里某处提到 delivery-verdict」是不够的：那句话可能被放在附录或
 *  最小演示里，而 Phase E 仍然是「验收 → 直接交付」。判据必须落在**决定**那一段。 */
function phaseE(text) {
  const i = text.indexOf('## 5. Phase E');
  assert.ok(i > 0, 'SKILL.md 的 Phase E 标题变了：找不到参照点');
  const j = text.indexOf('## 6. Phase F', i);
  assert.ok(j > i, 'SKILL.md 的 Phase F 标题变了：Phase E 段落无法界定');
  return text.slice(i, j);
}

// ── 1) SKILL.md 的 Phase E 真的调用它 ─────────────────────────────────

test('SKILL.md 的 Phase E 段内有一条 `node scripts/delivery-verdict.mjs` 调用', () => {
  const s = phaseE(read(SKILL));
  assert.match(s, /node scripts\/delivery-verdict\.mjs/,
    'Phase E 没有调用交付裁决 —— 那个函数有 39 条测试、零调用点（DF-080），'
    + '而一个没有调用点的门与不存在同形');
  // 四个输入都必须点到名：缺 `--redteam` 就等于「红队缺席 → 没有阻断项」的静默共识，
  // 缺 `--key-paths` 会让所有 block 条目变成 key_path_undeclared。
  for (const flag of ['--acceptor', '--redteam', '--key-paths']) {
    assert.ok(s.includes(flag), `Phase E 的调用缺 ${flag} —— 那条裁决会读到空输入`);
  }
});

test('SKILL.md 的 Phase E 段内给出「退出码 = 裁决」的对照，而不只是「跑一下」', () => {
  const s = phaseE(read(SKILL));
  // 退出码是这条命令唯一可被判定的输出。只写命令不写码，主线程会按「有没有报错」理解。
  assert.match(s, /\|\s*0\s*\|\s*`?PASS/, '没有把 exit 0 对到 PASS');
  assert.match(s, /\|\s*1\s*\|\s*`?FAILED/, '没有把 exit 1 对到 FAILED');
  assert.match(s, /\|\s*2\s*\|\s*`?BLOCKED/, '没有把 exit 2 对到 BLOCKED');
  assert.match(s, /3\s*\|\s*(用法错误|读不到)/, '没有说 exit 3 是什么 —— 缺文件的形态会被当成别的');
});

test('SKILL.md 的 Phase E 段内写明「验收 PASS + 红队 BLOCK」是合法输入且判 BLOCKED', () => {
  // 这一条是整份裁决的核心命题，也是唯一一个「两个结论都成立」的形态。
  // 不写清楚，主线程遇到它时会自己选一个 —— 而那正是裁决函数要终结的行为。
  const s = phaseE(read(SKILL));
  assert.match(s, /验收\s*PASS.*红队.*BLOCK|红队\s*BLOCK.*验收\s*PASS/,
    '没有写清「验收 PASS 但红队 BLOCK」的处置');
  assert.match(s, /BLOCKED/, '这种形态的裁决结论没有出现');
});

test('回退：把 Phase E 里那条调用删掉，上面的判据必须变假', () => {
  const original = read(SKILL);
  const mutated = original.replace(/node scripts\/delivery-verdict\.mjs[^\n]*/g, '（主线程自己看着办）');
  assert.notEqual(mutated, original, '找不到调用那一行，回退无法进行');
  const s = phaseE(mutated);
  assert.doesNotMatch(s, /node scripts\/delivery-verdict\.mjs/,
    '删掉之后判据仍然通过 —— 这条测试没有守住那一行');
});

// ── 2) CLI 能跑通真实输入（端到端，spawn 真进程）──────────────────────

const ACC_PASS = [
  '## 验收结论：通过',
  '',
  '## 逐项判定',
  '| # | 判定 | 证据 | 说明 | 关键路径 |',
  '|---|---|---|---|---|',
  '| AC1 | 通过 | scripts/app/route.ts:12 | 开关状态已断言 | K1 |',
  '',
  '```evidence-json',
  '[{"id":"E1","ac":"AC1","key_path":"K1","kind":"test","command":"node --test scripts/","producedBy":"acceptor"}]',
  '```',
  '',
].join('\n');

const RT_COVERAGE = [
  '## 覆盖声明',
  '- 我实际读了哪些文件：scripts/app/route.ts',
  '- 我做了哪些检查：空输入 / 超大输入 / 并发',
  '- 我**没**做什么：没测时区',
  '- 我无法核实的部分：浏览器兼容性',
  '',
].join('\n');

/** 一条 `dispatch=block` 的红队条目。`key_path` 必须与 `--key-paths` 里的 id 对得上，
 *  否则会被判 `key_path_undeclared`（那也是 BLOCKED，但不是本用例要验的那一条路）。 */
const RT_BLOCK = `## 反例列表
| # | 触发条件 | 失败表现 | 严重度 | dispatch | key_path | 证据 |
|---|---|---|---|---|---|---|
| RT1 | 空输入提交 | 界面开关停在旧值，日志仍报 success | high | block | K1 | scripts/app/route.ts:88 |

${RT_COVERAGE}`;

const RT_EMPTY = `## 反例列表
| # | 触发条件 | 失败表现 | 严重度 | dispatch | key_path | 证据 |
|---|---|---|---|---|---|---|

${RT_COVERAGE}`;

const KEYPATHS = [{ id: 'K1', path: 'scripts/app/route.ts', why: '用户点到的那个按钮' }];

/** 造一份「验收 PASS + 红队（可配）」的 run 目录，返回各文件路径。 */
function fixture(dir, { acceptor = ACC_PASS, redteam = RT_BLOCK, keyPaths = KEYPATHS } = {}) {
  const acc = join(dir, 'acceptor.md');
  const rt = join(dir, 'redteam.md');
  const kp = join(dir, 'keypaths.json');
  writeFileSync(acc, acceptor, 'utf8');
  writeFileSync(rt, redteam, 'utf8');
  writeFileSync(kp, JSON.stringify(keyPaths), 'utf8');
  return { acc, rt, kp };
}

const runCli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60000 });

test('CLI e2e：验收 PASS + 红队 block → BLOCKED（exit 2），且输出里两组结论都在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-dv-'));
  try {
    const f = fixture(dir);
    const r = runCli(['--acceptor', f.acc, '--redteam', f.rt, '--key-paths', f.kp]);
    assert.equal(r.status, 2, `应当是 BLOCKED（exit 2）：\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /BLOCKED/, r.stdout);
    assert.match(r.stdout, /验收结论：PASS/, '没有把验收的结论也留下 —— 两组结论都成立才是这条裁决的意义');
    assert.match(r.stdout, /RT1/, '没有点名阻断的那一条红队条目');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI e2e：对照组 —— 同样的验收、红队无阻断项 → PASS（exit 0）', () => {
  // 没有这一条，把 CLI 写成「永远 BLOCKED」也能让上面那条变绿。
  const dir = mkdtempSync(join(tmpdir(), 'ow-dv-'));
  try {
    const f = fixture(dir, { redteam: RT_EMPTY });
    const r = runCli(['--acceptor', f.acc, '--redteam', f.rt, '--key-paths', f.kp]);
    assert.equal(r.status, 0, `应当 PASS（exit 0）：\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /PASS/, r.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI e2e：验收判不通过 → FAILED（exit 1），与 BLOCKED 分开', () => {
  // 两个码都非零，但**处置不同**：FAILED 是修复后重验，BLOCKED 是补强证据/补采样。
  // 混成一个码，拿到裁决的人不知道该做什么。
  const dir = mkdtempSync(join(tmpdir(), 'ow-dv-'));
  try {
    const f = fixture(dir, {
      acceptor: ACC_PASS.replace('## 验收结论：通过', '## 验收结论：不通过')
        .replace('| AC1 | 通过 |', '| AC1 | 不通过 |'),
      redteam: RT_EMPTY,
    });
    const r = runCli(['--acceptor', f.acc, '--redteam', f.rt, '--key-paths', f.kp]);
    assert.equal(r.status, 1, `应当是 FAILED（exit 1）：\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /FAILED/, r.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI e2e：报告文件读不到 → exit 3，**不是** 0（读不到不等于通过）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-dv-'));
  try {
    const r = runCli(['--acceptor', join(dir, 'nope.md')]);
    assert.equal(r.status, 3, `读不到报告必须 exit 3：\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /读不到/, r.stderr);
    // 反向风险：把它写成 exit 0 就等于「文件不在 → 没有阻断项 → 可以发」。
    assert.notEqual(r.status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI e2e：不传 --acceptor → exit 3（没有验收就不存在「通过」）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-dv-'));
  try {
    const f = fixture(dir);
    const r = runCli(['--redteam', f.rt, '--key-paths', f.kp]);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /--acceptor/, r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI e2e：不传 --redteam 但验收 PASS → BLOCKED，**不是** PASS', () => {
  // 这一条是本轮自己抓到的一个洞。第一版 CLI 在缺 `--redteam` 时传 `redteam: null`，
  // 而 `deliverVerdict()` 里那句 `if (redteam && items.length === 0)` 会**短路**，
  // 于是所有红队判据都不生效、裁决给 `PASS`（实测 `exit 0 / 无阻断项、无风险项`）。
  // 而帮助文本写着「不传 = 红队缺席；**不是**「没有阻断项」」—— 文案与代码相反。
  //
  // 正确语义：红队缺席 = 没有覆盖声明 = 无法区分「查了没有问题」与「没有查」。
  // 所以缺 `--redteam` 必须落到 `redteam_no_coverage`（BLOCKED）。
  const dir = mkdtempSync(join(tmpdir(), 'ow-dv-'));
  try {
    const f = fixture(dir);
    const r = runCli(['--acceptor', f.acc, '--key-paths', f.kp]);
    assert.equal(r.status, 2, `缺红队报告必须 BLOCKED（exit 2）：\n${r.stdout}${r.stderr}`);
    assert.notEqual(r.status, 0, '缺红队报告却判 PASS —— 「红队缺席」被当成了「红队没问题」');
    assert.match(r.stdout, /redteam_no_coverage/, r.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI e2e：红队 block 但关键路径没声明过 → BLOCKED 且点名 key_path_undeclared', () => {
  // 这不是红队写错了，是「关键」必须预先声明的落点。判据必须把它与
  // 「真的有问题」分开 —— 两者的下一步不同（补声明 vs 修 bug）。
  const dir = mkdtempSync(join(tmpdir(), 'ow-dv-'));
  try {
    const f = fixture(dir, { keyPaths: [] });
    const r = runCli(['--acceptor', f.acc, '--redteam', f.rt, '--key-paths', f.kp]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /key_path_undeclared/, r.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI：--help 有输出且 exit 0 —— 入口守卫不能把帮助也静默掉', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /退出码/);
  assert.match(r.stdout, /0 PASS \/ 1 FAILED \/ 2 BLOCKED \/ 3/, '帮助里没有退出码契约');
});

test('CLI：被 import 时不执行 main（否则硬门的 import 探针会真的跑一遍裁决）', () => {
  // 与 entry-symlink.test.mjs 的第 5 条同源：入口守卫写松会让每次 import 都执行 main，
  // 而硬门会 import 这个模块 40 次。
  const probe = [
    `const m = await import(${JSON.stringify('file:///' + CLI.split('\\').join('/'))});`,
    "console.log(Object.keys(m).length > 0 ? 'imported-quietly' : 'no-exports');",
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 30000 });
  assert.equal(String(r.stdout || '').trim(), 'imported-quietly',
    `被 import 时执行了 main：${r.stdout}${r.stderr}`);
});

test('parseRedteamReport：表头驱动 —— 列序变了也读对，不按固定列号猜', () => {
  // 这是 `parseAcceptorVerdict` 的 key_path 一段的同一个教训：按列号读会把「说明」
  // 读成 key_path，于是强证据挂在一条不存在的路径上，判据永远判不过。
  const md = `## 反例列表
| 证据 | dispatch | # | 失败表现 | 触发条件 | 严重度 | 关键路径 |
|---|---|---|---|---|---|---|
| app.ts:9 | block | RT7 | 开关没变 | 空输入 | high | K2 |
`;
  const r = parseRedteamReport(md);
  assert.equal(r.items.length, 1, JSON.stringify(r));
  assert.equal(r.items[0].id, 'RT7');
  assert.equal(r.items[0].dispatch, 'block');
  assert.equal(r.items[0].key_path, 'K2');
  assert.equal(r.items[0].evidence, 'app.ts:9');
});

test('parseRedteamReport：读不出「反例列表」时报 problem，不返回空清单假装「没问题」', () => {
  const r = parseRedteamReport('## 别的节\n正文\n');
  assert.deepEqual(r.items, []);
  assert.ok(r.problems.length, '没有 problem —— 读不出与「没有反例」在屏幕上会同形');
  assert.match(r.problems.join(''), /反例列表/);
});

