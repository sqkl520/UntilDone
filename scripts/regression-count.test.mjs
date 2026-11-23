#!/usr/bin/env node
/**
 * regression-count.test.mjs — 「数得对」与「数错了会红」的回归测试。
 *
 * 缺陷来源（2026-11-21 红队）：硬门原先数源码里 `^\s*test(` 的字面量，得 1873；
 * 而 `node --test scripts/` 实跑报 1876。差的 3 条来自 `overwatch.test.mjs:305`
 * 的 `for` 循环：**一个 `test(` 字面量注册出 4 条测试**。
 *
 * 所以这里要钉两件事，缺一不可：
 *   1. **数得对**：循环注册必须按真实条数算（这是旧门错的地方）；
 *   2. **数错了会红**：加一条测试却忘改文档 → 硬门红；改了文档 → 那一条消失。
 *
 * 第二条**跑硬门真身**（子进程 + 临时仓库根），不复制判据。复制判据的测试只能
 * 证明「我抄的这份逻辑是对的」，而缺陷在另一份里 —— 本仓库已经吃过这个亏
 * （见 `roles.test.mjs` 的同类注释）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { countRegisteredTests, isNodeTestFile, nodeTestFiles } from './regression-count.mjs';

const REPO = join(import.meta.dirname, '..');

function tmpRepo() {
  const d = mkdtempSync(join(tmpdir(), 'ow-regression-count-'));
  return d;
}

// ── 0. 「哪些文件算测试」必须与 node --test 的目录模式一致 ─────────────

test('测试文件名判据必须覆盖 node --test 的全部模式，而不只是 *.test.mjs', () => {
  // 这六种是**逐个文件名实测**出来的 node --test 匹配集（见 regression-count.mjs 文件头）。
  for (const name of ['a.test.mjs', 'a-test.mjs', 'a_test.mjs', 'test-a.mjs', 'test.mjs', 'a.test.js']) {
    assert.equal(isNodeTestFile(name), true, `${name} 会被 node --test 执行，判据必须认它`);
  }
  for (const name of ['a.mjs', 'atest.mjs', 'testa.mjs', 'a.spec.mjs', 'a-tests.mjs', 'a_test.jsx']) {
    assert.equal(isNodeTestFile(name), false, `${name} 不会被 node --test 执行，不该算进去`);
  }
  // 真实翻车的那一条：生产模块叫 `test-count.mjs`，被 node 当成测试跑了一次。
  assert.equal(isNodeTestFile('test-count.mjs'), true,
    'test-*.mjs 是 node 的测试文件模式 —— 生产模块用这个名字会被全量跑时真执行一次');
});

test('收集测试文件要递归——node --test 会进子目录', () => {
  const d = tmpRepo();
  try {
    writeFileSync(join(d, 'top.test.mjs'), 'import { test } from "node:test";\ntest("a", () => {});\n');
    mkdirSync(join(d, 'sub'), { recursive: true });
    writeFileSync(join(d, 'sub', 'nested.test.mjs'), 'import { test } from "node:test";\ntest("b", () => {});\n');
    writeFileSync(join(d, 'sub', 'helper.mjs'), 'export const x = 1;\n');
    const found = nodeTestFiles(d);
    assert.deepEqual(found, ['sub/nested.test.mjs', 'top.test.mjs'],
      `只收测试文件、且递归：实际 ${JSON.stringify(found)}`);
    const r = countRegisteredTests(d);
    assert.equal(r.count, 2, `两条分别在两层的测试都要数到，实际 ${r.count}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ── 1. 取数口径：循环注册按真实条数算 ────────────────────────────────

test('循环里注册的 4 条测试必须数成 4 条——源码字面量只能数到 1', () => {
  const d = tmpRepo();
  try {
    const scripts = join(d, 'scripts');
    mkdirSync(scripts, { recursive: true });
    // 这条形状逐字对齐 `overwatch.test.mjs:305`：一个 `test(` 字面量，四条注册。
    writeFileSync(join(scripts, 'loop.test.mjs'), `
import { test } from 'node:test';
test('孤立的', () => {});
for (const cmd of ['scan', 'verify', 'tui', 'watch']) {
  test('ro 路由：' + cmd, () => {});
}
`);
    const r = countRegisteredTests(scripts);
    assert.equal(r.error, undefined, `取数失败：${JSON.stringify(r)}`);
    assert.equal(r.count, 5,
      `应为 1（孤立）+ 4（循环）= 5 条，实际 ${r.count}。`
      + '若这里返回 2，说明又退回了「数字面量」——那正是本缺陷本身');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('源码字面量与真实注册数在有循环时确实不同（这就是 1873 vs 1876 的来源）', () => {
  const d = tmpRepo();
  try {
    const scripts = join(d, 'scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'loop.test.mjs'), `
import { test } from 'node:test';
test('甲', () => {});
test('乙', () => {});
for (const n of [1, 2, 3]) test('丙' + n, () => {});
`);
    const r = countRegisteredTests(scripts);
    assert.equal(r.count, 5, `真实注册 2 + 3 = 5，实际 ${r.count}`);
    assert.equal(r.files, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ── 2. 取数的失效方式：数不出来 ≠ 0 条 ────────────────────────────────

test('字符串里的 test( 不是测试——旧口径会把它数进去（多数方向）', () => {
  // 这是我这条新测试文件在旧口径下暴露出的**第二个失效方向**：
  // 旧判据 `^\s*test\(` 只看行首缩进，不看它在不在字符串/模板串里。
  // 于是「把一段示例测试当夹具写进测试文件」这种完全正常的写法，会让条数**虚高**。
  // 实测：本仓加进 regression-count.test.mjs 之后，旧口径 1913 / 真实注册 1905，差 +8。
  const d = tmpRepo();
  try {
    const scripts = join(d, 'scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'fixture.test.mjs'), [
      "import { test } from 'node:test';",
      "test('真的这一条', () => {});",
      'const FIXTURE = `',
      "test('甲', () => {});",
      "test('乙', () => {});",
      "for (const n of [1, 2]) test('丙' + n, () => {});",
      '`;',
      'void FIXTURE;',
    ].join('\n'));
    const r = countRegisteredTests(scripts);
    assert.equal(r.count, 1,
      `字符串里的 4 处 test( 不该被算进来，实际 ${r.count}。`
      + '若这里是 5，说明退回了「数字面量」——它会同时多数（字符串）和少数（循环）');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('目录读不了时返回 error，而不是假装「0 条」（0 条会让门静默放行）', () => {
  const r = countRegisteredTests(join(tmpdir(), 'ow-testcount-does-not-exist-xyz'));
  assert.ok(r.error, `应报错，实际 ${JSON.stringify(r)}`);
  assert.equal(r.count, undefined, '不确定的结论必须是 undefined，不能是 0');
});

test('import 就抛的测试文件要报出来——它那几条在真实运行里根本不存在', () => {
  const d = tmpRepo();
  try {
    const scripts = join(d, 'scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'ok.test.mjs'), `
import { test } from 'node:test';
test('好的那条', () => {});
`);
    writeFileSync(join(scripts, 'broken.test.mjs'), `
throw new Error('模块顶层就炸了');
`);
    const r = countRegisteredTests(scripts);
    assert.equal(r.count, 1, `只应数到好的那 1 条，实际 ${r.count}`);
    assert.equal(r.errors.length, 1, `必须报出 broken.test.mjs：${JSON.stringify(r.errors)}`);
    assert.match(r.errors[0][0], /broken\.test\.mjs/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ── 2b. 平台无关性：skip 不影响注册、两个平台数出同一个数 ──────────────
//
// 2026-11-21 的一次 CI 红被归因成「`skip: process.platform !== 'win32'` 让真实注册数
// 平台相关」。那个归因**是错的**，而它错得很有说服力 —— 本仓确实有 6 处按平台 skip 的
// 用例。两条用例把这件事钉死，免得下一次又靠推理去判定。

test('skip 只影响跑不跑，不影响注册数——被 skip 的用例照样进总数', () => {
  const d = tmpRepo();
  try {
    const scripts = join(d, 'scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'plat.test.mjs'), [
      "import { test } from 'node:test';",
      "test('无条件的', () => {});",
      "test('只在 win32', { skip: process.platform !== 'win32' }, () => {});",
      "test('只在非 win32', { skip: process.platform === 'win32' }, () => {});",
    ].join('\n'));
    const r = countRegisteredTests(scripts);
    // 三条都被注册：`node --test` 的 `ℹ tests` 同样是 3（其中 2 条进 `ℹ skipped`）。
    assert.equal(r.count, 3,
      `skip 不影响注册，应数到 3 条，实际 ${r.count}。`
      + '若这里是 1 或 2，说明取数把 `skip` 当成「没注册」—— 那会让条数随平台变化');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('win32 与 linux 注册出同一个数——条件注册才会破坏这条，本仓当前没有', () => {
  // 这条跑**真仓库**：它守的是「文档写一个数」这件事成立的前提。
  // 将来谁写了 `if (process.platform === …) test(…)`，这里会先红，
  // 而不是等 CI 与本地对不上、再被人归因成别的东西。
  const win = countRegisteredTests(join(REPO, 'scripts'), { platform: 'win32' });
  const linux = countRegisteredTests(join(REPO, 'scripts'), { platform: 'linux' });
  assert.equal(win.error, undefined, `win32 取数失败：${JSON.stringify(win)}`);
  assert.equal(linux.error, undefined, `linux 取数失败：${JSON.stringify(linux)}`);
  assert.equal(win.count, linux.count,
    `两个平台注册数不同（win32 ${win.count} / linux ${linux.count}）——`
    + '仓里出现了平台相关的**条件注册**，而文档里只有一个数字。'
    + '要么去掉条件注册（用 skip 代替），要么文档与硬门都得改口径');
});

// ── 3. 负向：加了测试却忘改文档 → 硬门红；改文档 → 那一条消失 ─────────

/** 跑硬门真身。临时仓库根只放这一件事需要的东西（`scripts/` + `README.md`），
 *  其余检查会各自报缺文件——那是**别的**违规，本用例只断言「测试数」这一条。 */
function runGateIn(dir) {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'check-structure.mjs')], {
    cwd: dir, encoding: 'utf8', timeout: 120000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const TESTCOUNT_VIOLATION = /回归测试数写的是 (\d+)，实跑注册 (\d+) 条/;

test('加一条测试而文档没改 → 硬门红；把文档改成实数 → 那一条消失', () => {
  const d = tmpRepo();
  try {
    const scripts = join(d, 'scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'a.test.mjs'), `
import { test } from 'node:test';
test('甲', () => {});
test('乙', () => {});
`);
    // 文档声明 2 条：此刻与真实注册数一致。
    writeFileSync(join(d, 'README.md'),
      '# 假仓库\n\n跑法：`node --test scripts/`（2 条回归测试；数字由硬门对账）。\n');

    const green = runGateIn(d);
    assert.ok(!TESTCOUNT_VIOLATION.test(green.out),
      `数字一致时不该报测试数违规：\n${green.out}`);

    // 加第三条测试，**忘了改文档** —— 这正是「加一条测试就漂」的那个失效方式。
    writeFileSync(join(scripts, 'a.test.mjs'), `
import { test } from 'node:test';
test('甲', () => {});
test('乙', () => {});
test('丙', () => {});
`);
    const red = runGateIn(d);
    const m = red.out.match(TESTCOUNT_VIOLATION);
    assert.ok(m, `加了测试却没改文档，硬门必须红（这是本用例的全部意义）：\n${red.out}`);
    assert.equal(m[1], '2', `文档里写的应是 2，门读到 ${m[1]}`);
    assert.equal(m[2], '3', `实跑注册应是 3，门读到 ${m[2]}`);
    assert.notEqual(red.code, 0, '有违规时退出码必须非 0');

    // 改文档 → 那一条消失（其余「缺 .gitignore」之类的违规与本用例无关，不参与断言）。
    writeFileSync(join(d, 'README.md'),
      '# 假仓库\n\n跑法：`node --test scripts/`（3 条回归测试；数字由硬门对账）。\n');
    const back = runGateIn(d);
    assert.ok(!TESTCOUNT_VIOLATION.test(back.out),
      `文档改成实数后不该再报测试数违规：\n${back.out}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('删掉声明本身也要红——「没人再核它」比写错更坏', () => {
  const d = tmpRepo();
  try {
    // 「必须声明测试数」是 **product 域**的规矩（DF-051）：它是本产品对外的自证位置。
    // 别人的项目 README 里没有这个数，不是缺陷 —— 所以那条规则只在 productRepo=true 时判。
    // 本用例要验的正是「本产品自己的仓库删掉声明会不会红」，因此显式声明 productRepo。
    mkdirSync(join(d, '.untildone'), { recursive: true });
    writeFileSync(join(d, '.untildone', 'checks.json'), JSON.stringify({ productRepo: true }, null, 2));
    const scripts = join(d, 'scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'a.test.mjs'), `
import { test } from 'node:test';
test('甲', () => {});
`);
    writeFileSync(join(d, 'README.md'), '# 假仓库\n\n跑法：`node --test scripts/`。\n');
    const r = runGateIn(d);
    assert.match(`${r.out}`, /找不到回归测试数声明/,
      `文档里删掉数字必须红（否则数字漂了也没人知道）：\n${r.out}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
