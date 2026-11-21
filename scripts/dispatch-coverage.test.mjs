// 元检查的回归测试：**删掉任意一条 dispatch，门必须红**（DF-047）。
//
// ## 这一份为什么必须以「改源码 + 跑子进程」的形式存在
//
// 元检查守的是「`CHECKS` 表里每一条都真的被调用」。这条判据的对象**就是本仓的源码**，
// 而不是某个可构造的输入 —— 要验它，唯一诚实的办法是把源码改坏，再跑一次真身。
// 用正则从源码里读清单再自己比对 = 自证，本仓栽过好几次（DF-039/DF-040/DF-042），
// 而且那种测试在「判据本身被删掉」时照样绿。
//
// ## 每个用例的形态
//
//   1. 复制整个仓库到临时目录（不含 .git / dist / node_modules / 临时物）；
//   2. 在副本里把某一条 dispatch 改坏；
//   3. 跑 `node scripts/check-structure.mjs`（子进程，真身）；
//   4. 断言它**非零退出**，且输出里点名那条检查。
//
// 复制一份而不是就地改，是因为就地改会在测试中途让仓库进入坏状态 ——
// 一旦断言失败（throw），`finally` 之前的还原就来不及跑，仓库会留在坏形态里。
//
// 实测：单次复制约 0.4s（不含 .git 与 tasks/runs 时 ~2MB），三次用例合计 < 5s。

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

/** 临时副本。排除的东西都是「跑门不需要、且会让复制变慢/变红」的：
 *  · `.git`：`checkChangelog()` 在非 git 仓库上**正确地**跳过（那是解压发布包的形态），
 *    带上它反而会让用例依赖本仓的提交历史；
 *  · `dist` / `node_modules`：产物与依赖；
 *  · `tasks/runs`：运行台账，含会话 ID，且体积大；
 *  · `.scratch` / `.tmp-*` / `.mkbefore*`：临时物 —— 它们其中就有本文件描述的
 *    「另一个会话正在写这个仓库」留下的文件，带上会让结构门为本仓之外的原因报红。 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ow-dispatch-'));
  cpSync(REPO, dir, {
    recursive: true,
    filter: (src) => {
      const r = src.slice(REPO.length).replace(/\\/g, '/');
      if (!r) return true;
      // `.git` 必须**精确匹配到那一个目录**，不能写成 `startsWith('/.git')` ——
      // 那会把 `.github/` 一起排掉（实测：`/.github` 以 `/.git` 开头），
      // 于是副本里没有 `.github/workflows/validate.yml`，而 README 引用了它，
      // 硬门红在一个与本用例完全无关的地方。第一版就这么错过了。
      if (r === '/.git' || /^\/\.git\//.test(r)) return false;
      if (r.startsWith('/dist') || r.startsWith('/node_modules')) return false;
      if (r.startsWith('/tasks/runs')) return false;
      if (r.startsWith('/.scratch')) return false;
      // **任何点开头的临时/分析目录都不带**。实测本仓根下有 `.tmp-analysis/`
      // 296 MB（第三方仓库 + 语料切片），带上它单次复制要 3 秒以上，
      // 四个用例合计 70 秒 —— 而这些内容对硬门毫无用处。
      //
      // 但只能滤**目录**：`.gitignore` 是根级**文件**，按「段名以点开头」一刀切
      // 会把 `.gitignore` 一起滤掉（第一版就是这么错的，门随后报「.gitignore 不存在」，
      // 而那是本用例完全无关的红）。所以这里只看「第二段是目录名且以点开头」，
      // 可以用 `statSync` 判断，也可以直接维护一份白名单 —— 目录是有限的一组。
      const seg = r.split('/')[1] || '';
      if (r.split('/').length > 2 && seg.startsWith('.')
        && seg !== '.github' && seg !== '.claude' && seg !== '.untildone') return false;
      if (/\/\.(mkbefore|tmp)/.test(r) || /\.tmp\./.test(r)) return false;
      return true;
    },
  });
  syncTestCount(dir);
  return dir;
}

/** 在副本里跑硬门（子进程，真身）。
 *
 *  ## 为什么要重试一次
 *
 *  `checkImportable()` / `checkUnregisteredExports()` 在硬门内部各起一个 node 子进程，
 *  分别有 45s / 20s 的超时。`node --test scripts/` 默认**多文件并发**，而本文件自己
 *  还要复制仓库、再各跑一次门 —— 实测并发满载时那个子进程会超时返回 `status: null`，
 *  于是门输出「子进程以 null 退出」并 exit 1。
 *
 *  那是**环境性失败**，不是判据给出的结论。第一版没区分，于是对照组在全量跑里
 *  红了（隔离跑 3/3 绿，全量跑 1 红）—— 一条本来要守「门不会永远红」的用例，
 *  自己被资源抢成了「门是红的」。这种用例比没有更坏：它训练人忽略红。
 *
 *  重试的判据是**只认环境性信号**（超时 / 无输出），不是「红了就再跑一次」——
 *  后者会把真正的判据失败也重试一遍，那是在等一个它不会变绿的结果。
 *
 *  @returns {{status:number|null, out:string, envFail:boolean}} */
function runGate(dir, { tries = 2 } = {}) {
  let last = { status: null, out: '', envFail: true };
  for (let i = 0; i < tries; i++) {
    const r = spawnSync(process.execPath, [join(dir, 'scripts', 'check-structure.mjs')], {
      cwd: dir, encoding: 'utf8', timeout: 180000,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    // `status === null` = 被信号杀掉或超时（spawnSync 在超时时置 null）
    const envFail = r.status === null && /子进程以 null 退出|未知错误/.test(out);
    last = { status: r.status, out, envFail };
    if (!envFail) return last;
    // 只在这种形态下重试；其余情况立刻返回，让判据说话。
  }
  return last;
}

/** 让副本里的「测试数对账」与副本自身一致。
 *
 *  ## 为什么这是必要的，而且**不是**在掩盖缺陷
 *
 *  副本多带了本文件（4 条用例），而 `checkTestCount()` 会数副本里的测试文件、
 *  与四份文档里写的数字对账 —— 于是副本必然红在这条上，与元检查毫无关系。
 *  实测：第一版就是这样红的（文档 1882 / 副本实测 1904），两条对照用例因此失败。
 *
 *  这里不把那四份文档改成写死 1904（那会在本仓加一条永远要跟着改的假话），
 *  而是**让副本自己说真话**：跑一次门，从它自己的输出里读出「实跑注册 N 条」，
 *  再把四份文档里的数字换成 N。这样副本里的对账是**真通过**，而不是被跳过。
 *
 *  判据仍留在原地：改完之后副本照样会对「数字对不对」做一次完整核对。
 *  @returns {void} */
function syncTestCount(dir) {
  const first = runGate(dir);
  const m = first.out.match(/实跑注册 (\d+) 条/);
  if (!m) return first;                 // 没有这条违规：数字本来就对得上
  const n = m[1];
  const sites = [
    ['README.md', /（(\d+)\s*条回归测试/g],
    ['CLAUDE.md', /全量回归测试（(\d+)\s*条/g],
    ['docs/GUIDE.md', /(\d+)\s*项全绿/g],
    ['.github/workflows/validate.yml', /全部回归测试（(\d+)\s*条/g],
    // README 的徽章与正文各有一处，两个正则都覆盖。
    // 徽章不带 `passing` 字样：本仓有 2 条按平台 skip 的用例，写 `passing` 会把
    // 「注册 1908 条」说成「1908 条通过」，而 `ℹ pass` 少于它。
    ['README.md', /regression%20tests-(\d+)/g],
  ];
  for (const [rel, re] of sites) {
    const p = join(dir, rel);
    const text = readFileSync(p, 'utf8');
    const next = text.replace(re, (full, old) => full.replace(old, n));
    if (next !== text) writeFileSync(p, next);
  }
  // 把第一次跑的输出交回去：调用方（`before()`）拿它当「同步之后的那次运行」，
  // 省掉一整个子进程。**注意它是在同步之前跑的**，所以它的 `实跑注册 N 条`
  // 那一行仍然有效（N 与文档里的数字才是不一致的那两方），但**不能**拿它当
  // 「门是绿的」的证据 —— 那次运行的结论就是「数字对不上」。
  return first;
}

const GATE = join('scripts', 'check-structure.mjs');
const readGate = (dir) => readFileSync(join(dir, GATE), 'utf8');
const writeGate = (dir, text) => writeFileSync(join(dir, GATE), text);

// ## 一份基准副本，四个用例各自廉价复制
//
// 第一版每个用例都 `cpSync` 整个仓库并跑两次门（一次在 `syncTestCount()`，
// 一次在用例里），四个用例合计 70 秒。对一个「改动后必跑」的硬门回归集来说，
// 这会让 `node --test scripts/` 的时长翻倍。
//
// 现在：基准副本只建一次（`before()`），每个用例从它 `cpSync` 一份（约 8 MB），
// 只跑一次门。实测三个用例合计 ~25 秒。
let BASE = null;
/** 基准副本「同步完测试数之后」的那次门运行结果。
 *
 *  复用它的理由：`fixture()` 里已经跑过一次门（为了对齐测试数），而那一次之后
 *  基准副本就是**未改动的绿状态**。对照组要的正是这个结论 —— 再跑一次得到的是
 *  同一件事，只是多花 9 秒。省掉它，全量测试少一次 40 文件的 import 探针。 */
let BASE_GATE = null;

test.before(() => {
  BASE = fixture();
  BASE_GATE = runGate(BASE);
});
test.after(() => { if (BASE) rmSync(BASE, { recursive: true, force: true }); });

/** 从基准副本再复制一份给单个用例改坏用。 */
function sandbox() {
  assert.ok(BASE, '基准副本没有建起来 —— `before()` 没跑？');
  const dir = mkdtempSync(join(tmpdir(), 'ow-case-'));
  cpSync(BASE, dir, { recursive: true });
  return dir;
}

/** 断言「这条检查被点了名，且门非零退出」。
 *
 *  **两件事都要断言**。只断言非零退出是不够的：那个临时的门可能因为与本用例
 *  无关的原因红（比如并行会话留下的临时文件），于是用例在「元检查根本没工作」时
 *  也会绿 —— 那正是这个仓库反复批评的「看见 ≠ 判红」。 */
function assertRed(status, out, needle, label) {
  assert.notEqual(status, 0, `${label}：门应当非零退出，实际 exit ${status}\n${out}`);
  assert.match(out, needle, `${label}：输出里没有点名它\n${out}`);
}

/** 环境性失败（子进程超时）必须**显式失败并说清是什么**，不能伪装成判据结论。
 *  静默 skip 会让「检查被删」和「机器忙」同形 —— 那正是本轮在修的那个病。 */
function assertNotEnvFail(res, label) {
  assert.ok(!res.envFail,
    `${label}：硬门内部的子进程超时（环境性失败，不是判据结论）。`
    + `隔离重跑 \`node --test scripts/dispatch-coverage.test.mjs\` 应能通过。\n${res.out}`);
}

test('元检查 · 从 CHECKS 表里删掉一行 → 门必须红（DF-047 的原样）', () => {
  const dir = sandbox();
  try {
    const before = readGate(dir);
    const after = before.replace("  ['ledger', checkLedger],\n", '');
    assert.notEqual(after, before, '没有匹配到 ledger 那一行 —— 本用例的前提失效了');

    writeGate(dir, after);
    const res = runGate(dir);
    assertNotEnvFail(res, '门运行');
    const { status, out } = res;
    assertRed(status, out, /CHECK_NAMES 里有 \d+ 条检查在 CHECKS 表里找不到：.*ledger/, '删表行');
    assert.match(out, /只改一处会红在这里/, '没有给出「为什么红」的说明');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('元检查 · 表行还在但调用被跳过 → 门必须红（真删 dispatch 调用）', () => {
  const dir = sandbox();
  try {
    // 这是决定性实验的更隐蔽形态：`CHECKS` 表完整，只有运行循环里不再调它。
    // 只对 `CHECKS` ↔ `ran` 的元检查**抓不到**「表行被删」那一半，
    // 所以两个用例都要有 —— 它们守的是元检查的两条不同的腿。
    const before = readGate(dir);
    const anchor = 'for (const [name, fn] of CHECKS) {\n  if (disabled.has(name)) continue;\n  fn();';
    const after = before.replace(anchor,
      'for (const [name, fn] of CHECKS) {\n  if (disabled.has(name)) continue;\n  if (name === \'ledger\') continue;\n  fn();');
    assert.notEqual(after, before, '没有匹配到运行循环 —— 本用例的前提失效了');

    writeGate(dir, after);
    const res = runGate(dir);
    assertNotEnvFail(res, '门运行');
    const { status, out } = res;
    assertRed(status, out, /CHECKS 表里有 \d+ 条检查本轮从未被调用：.*ledger/, '跳过调用');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('元检查 · 对照组：未改动的仓库全绿，条数与表一致，且「没跑」与「通过」不同形', () => {
    // 复用 `before()` 里那次运行的结果（基准副本已对齐测试数，状态即「未改动」）。
    // 复制一份副本只为读它的源码数表行 —— 不跑门。
    const res = BASE_GATE;
    assert.ok(res, '基准副本的门运行结果没有拿到 —— `before()` 没跑？');
    assertNotEnvFail(res, '门运行');
    const { status, out } = res;
    // 这一条是**对照组**：没有它，上面两条可能只是「门在任何输入下都红」。
    assert.equal(status, 0, `未改动的副本应当绿，实际 exit ${status}\n${out}`);
    const m = out.match(/✓ 已执行的 (\d+) 条检查全部通过|✓ 结构检查全部通过（(\d+) 条/);
    assert.ok(m, `输出里没有「已执行 N 条」那句话：\n${out}`);

    // 条数必须与 CHECKS 表的行数一致 —— 否则「N 条全部通过」这个数字本身可以是假话
    // （少报几条，「全部通过」就更容易成立）。
    //
    // 数行时**不能写 `check\w+`**：`emptyDirs` 那一条是箭头函数（`() => checkEmptyDirs()`），
    // 不是裸标识符。第一版就是这么少数了一行（数出 24、实际 25），
    // 于是这一条对照用例在「输出完全正确」时红了 —— 判据自己错，报出来的却是被判断对象。
    const src = readGate(BASE);
    const tableRows = (src.match(/^  \['\w+', .+\],$/gm) || []).length;
    assert.ok(tableRows > 0, '没有数到 CHECKS 表的行 —— 本用例的前提失效了');
    const declared = Number(m[1] || m[2]);
    assert.equal(declared, tableRows,
      `输出说执行了 ${declared} 条，而 CHECKS 表里有 ${tableRows} 行`);

    // 本仓现状必然有「未跑」项（`rules/`、`spec-adr/`、`local/`、`CLAUDE.local.md`
    // 四个都不在盘上）。**「没跑」必须与「通过」在输出上不同形** ——
    // 这是 DF-047 的核心要求：旧版只有 `✓` 和 `✗` 两种结尾，「因文件不存在而提前
    // return」落进 `✓`，读者无从分辨。
    if (/— \d+ 处未跑/.test(out)) {
      assert.doesNotMatch(out, /✓ 结构检查全部通过/,
        `有未跑项，却仍印了「✓ 结构检查全部通过」—— 那正是本缺陷的原始形态：\n${out}`);
      assert.match(out, /✓ 已执行的 \d+ 条检查全部通过/,
        '有未跑项时，通过那句话必须显式限定为「已执行的部分」');
    }
});

