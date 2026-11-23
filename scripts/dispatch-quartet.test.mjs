// 返回格式四元组检查的回归测试（P0-1 第二项）。
//
// ## 为什么这一份必须是「改文件 + 跑子进程」
//
// `checkDispatchQuartet()` 判的对象是**仓库里那四份文档的字节**。要验它，
// 唯一诚实的办法是把那几份里的几份改坏，再跑一次**真身**（`scripts/check-structure.mjs`）。
//
// 从源码里读清单再自己比对 = 自证：本仓栽过好几次（DF-039 / DF-040 / DF-042 / DF-047），
// 那种测试在「判据本身被删掉」时照样绿 —— 而被删掉正是它要防的事。
//
// ## 一条判据的两次翻车，就是这份测试的由来
//
//  1. **第一版按「全文出现过这一行」判**。`templates/dispatch.md` 里
//     `## 我产出的文件` 出现 4 次（格式块 1 次 + 正文 3 次），删掉格式块里那一次，
//     全文仍然有 → 判据绿。实测就是这么漏的。
//  2. **第二版锚在「输出节里第一个代码围栏」**，但节边界按 `^#{1,2} ` 判，
//     而围栏里**就是** `## 交付物` 这些行 → 切片在围栏第一行就结束，
//     四份载体全部误报「围栏没有闭合」，而那四份文件都完好。
//
// 所以现在的判据是：输出节标题 → **跳过围栏内的行**找到真正的节边界 → 第一个围栏 → 逐行核字段。
// 下面两组用例分别钉住这两件事：端到端那一组证明**接线**在、单元那一组证明**边界逻辑**对。
//
// ## 为什么只跑一次门
//
// 跑一次真身约 9–30 秒（它内部还要起子进程数测试条数）。三次变异各跑一次会让
// 这个文件独占 80 秒，而它与 `dispatch-coverage.test.mjs` 的成本叠加后
// 会让 `node --test scripts/` 的时长翻倍 —— 那是本仓明确拒绝过的形态
// （见 `dispatch-coverage.test.mjs` 的「一份基准副本」注释）。
//
// 所以：**把三处变异放进同一份副本、一次门运行**，且**只改三份、留一份不动** ——
// 没被改的那一份同时充当对照：它的名字不许出现在报错里。

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { outputFenceLines, quartetGaps, QUARTET_FIELDS } from './dispatch-quartet.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const SPEC = 'docs/spec/dispatch-contract.md';
const TEMPLATE = 'templates/dispatch.md';
const EXECUTOR = '.claude/agents/oversight-executor.md';
const REPAIR = '.claude/agents/oversight-repair.md';

/** 临时副本。过滤规则与 `dispatch-coverage.test.mjs` 的 `fixture()` 同源：
 *  排除 `.git`（非 git 仓库时 `checkChangelog` 会**正确地**跳过）、产物、运行台账、临时分析目录。
 *  **`.git` 必须精确匹配那一个目录**：写成 `startsWith('/.git')` 会把 `.github/` 一起排掉。
 *
 *  ## 为什么在副本里显式关掉两条检查
 *
 *  `testCount` 与 `importable` 各自要起一个子进程、import 全部 51 个测试文件（45 秒超时）。
 *  它们与本用例要验的判据**没有任何关系**，而实测在冷缓存下两者合计占掉这次门运行的
 *  大部分时间（实测副本里整次门 50.7 秒，本仓热缓存 15.8 秒）。
 *
 *  关掉它们用的是**产品自带的机制**（`.untildone/checks.json` 的 `disabledChecks`），
 *  门会在输出里逐条打印「检查 X 已被关闭」—— 所以这不是「偷偷少跑」，
 *  而且本用例断言的是**四元组那一条**报了什么错，不是「整次门的结果」。
 *  少跑两条无关检查不会让这条断言变假。 */
const DISABLED_FOR_TEST = ['testCount', 'importable'];

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'ow-quartet-'));
  cpSync(REPO, dir, {
    recursive: true,
    filter: (src) => {
      const r = src.slice(REPO.length).replace(/\\/g, '/');
      if (!r) return true;
      if (r === '/.git' || /^\/\.git\//.test(r)) return false;
      if (r.startsWith('/dist') || r.startsWith('/node_modules')) return false;
      if (r.startsWith('/tasks/runs')) return false;
      if (r.startsWith('/.scratch')) return false;
      const seg = r.split('/')[1] || '';
      if (r.split('/').length > 2 && seg.startsWith('.')
        && seg !== '.github' && seg !== '.claude' && seg !== '.untildone') return false;
      if (/\/\.(mkbefore|tmp)/.test(r) || /\.tmp\./.test(r)) return false;
      return true;
    },
  });
  // 关掉与本题无关的两条（理由见上）。写进副本自己的配置，**不改本仓的配置**。
  const cfgPath = join(dir, '.untildone', 'checks.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.disabledChecks = DISABLED_FOR_TEST;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  return dir;
}

/** 跑真身。**环境性失败**（子进程被信号杀掉 / 超时 / 无输出）必须显式失败，
 *  不能伪装成「判据通过」—— 那正是本仓反复批评的「没跑」与「通过」同形。 */
function runGate(dir) {
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'check-structure.mjs')], {
    cwd: dir, encoding: 'utf8', timeout: 240000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.ok(r.status !== null,
    `硬门子进程没有正常退出（超时或被杀）—— 这是环境性失败，不是判据结论：\n${out}`);
  assert.ok(out.length > 0, '硬门没有任何输出 —— 探针坏了，不能据此判任何事');
  return { status: r.status, out };
}

/** 只在**输出格式的代码围栏内**删掉一个字段标题。
 *
 *  为什么必须限定在围栏内：正文里也写着这些字段名（纪律说明会引用它们）。
 *  删正文那一次不会改变子 Agent 照抄的模板，因此**不该**判红 —— 本测试如果用
 *  `String.replace` 删第一次出现，挡住的就不是真正的失效形态。 */
function dropInOutputFence(text, heading) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^##\s*(?:\d+\.\s*)?(?:返回值格式|输出.*)$/.test(l.trim()));
  assert.ok(start >= 0, `找不到输出节标题 —— 本用例的前提失效了：${heading}`);
  let fence = 0;
  let opened = false;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^```/.test(t)) {
      if (!opened) { opened = true; fence = i; } else break;   // 第一个围栏的开 → 闭
      continue;
    }
    if (opened && i > fence && t === heading) {
      lines.splice(i, 1);
      return lines.join('\n');
    }
  }
  throw new Error(`围栏里没有那一行：${heading}`);
}

const MSG = /输出格式的代码围栏里缺少 \d+ 个字段/;

test('端到端 · 三份载体的围栏各删一处 → 门红并点名这三份，未动的那份不出现', () => {
  const dir = sandbox();
  try {
    // 三处变异，一次门运行。**规格（SPEC）不动**，它充当同一次运行里的对照。
    //   · 模板删「## 交付物」                —— 格式块内那一行（正文里还有 3 处同样的行）
    //   · executor 删「## 我认为的薄弱点」
    //   · repair 删「## 我产出的文件」
    writeFileSync(join(dir, TEMPLATE),
      dropInOutputFence(readFileSync(join(dir, TEMPLATE), 'utf8'), '## 交付物'), 'utf8');
    writeFileSync(join(dir, EXECUTOR),
      dropInOutputFence(readFileSync(join(dir, EXECUTOR), 'utf8'), '## 我认为的薄弱点'), 'utf8');
    writeFileSync(join(dir, REPAIR),
      dropInOutputFence(readFileSync(join(dir, REPAIR), 'utf8'), '## 我产出的文件'), 'utf8');

    const res = runGate(dir);
    assert.notEqual(res.status, 0, `删掉字段后门应当非零退出：\n${res.out}`);
    assert.match(res.out, MSG, `输出里没有点名四元组缺失：\n${res.out}`);

    const named = [...res.out.matchAll(/^\s+\[([^\]]+)\] 输出格式的代码围栏里缺少/gm)].map((m) => m[1]);
    assert.deepEqual(named.sort(), [REPAIR, TEMPLATE, EXECUTOR].sort(),
      `被点名的文件必须正好是被改坏的那三份（实际：${named.join(', ')}）\n${res.out}`);
    // 对照：没被改的那一份**不许**出现在这条报错里。
    assert.ok(!named.includes(SPEC), `未改动的 ${SPEC} 被误报：\n${res.out}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('单元 · outputFenceLines 跳过围栏内的伪标题（第二版翻车的那个 bug）', () => {
  // 这组用例固定的是「围栏里的 `## 交付物` 不是节边界」。
  // 它值得单测，是因为真实仓里跑一次门要 9–30 秒，而这条逻辑的两种错法
  // （切片过早 / 围栏未闭合误判）都不会在本仓当前文档上暴露 —— 只在有人
  // 改动文档结构时才炸，那时离根因已经很远。
  const text = [
    '## 1. 前言',
    '正文',
    '## 6. 返回值格式',
    '',
    '```markdown',
    '## 交付物',
    'x',
    '',
    '## 执行日志',
    'y',
    '',
    '## 我认为的薄弱点',
    'z',
    '',
    '## 我产出的文件',
    '- a',
    '```',
    '',
    '## 7. 下一节',
    '正文',
  ].join('\n');
  const got = outputFenceLines(text);
  assert.ok(!got.error, `不该报错：${got.error}`);
  assert.deepEqual(got.lines, [
    '## 交付物', 'x', '', '## 执行日志', 'y', '',
    '## 我认为的薄弱点', 'z', '', '## 我产出的文件', '- a',
  ], '围栏内容被节边界截断了（第二版 bug 复现）');
});

test('单元 · outputFenceLines 对三种坏输入都报错，不返回空数组', () => {
  // 「返回空数组」是最坏的形态：调用方会把它读成「一个字段都没有」，
  // 与「读不到格式」在屏幕上同形，而下一条检查会拿它当「全缺」报四条无关的错。
  assert.match(outputFenceLines('没有输出节').error || '', /找不到「输出/);
  assert.match(outputFenceLines('## 输出\n\n没有围栏').error || '', /没有代码围栏/);
  assert.match(outputFenceLines('## 输出\n\n```md\n## 交付物\n').error || '', /没有闭合/);
});

test('单元 · CRLF 文档必须与 LF 文档得到同一个结果（Windows 上的一次性四条误报）', () => {
  const lf = '## 输出\n\n```md\n## 交付物\n## 我产出的文件\n```\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.deepEqual(outputFenceLines(crlf), outputFenceLines(lf));
});
