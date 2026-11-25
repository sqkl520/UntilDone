#!/usr/bin/env node
/**
 * hub-verifier.test.mjs — 主线程自述核验角色「有没有真的被派发」（DF-082）。
 *
 * ## 它守的是什么
 *
 * 本仓的门禁全都在核 Spoke：验收核交付物、红队攻击结论、批判核拆解图。
 * **主线程自己不在验证范围内。** 实测（2026-11-23）：一个真实会话里主线程犯了 7 次错，
 * 5 次被 Spoke 用可复现证据抓住，其中**一半是事实类断言**（说了一个数字、一句话）。
 * 这类错误不需要判断力去发现，只需要有人跑一遍命令 —— 而此前没有角色被派去做这件事。
 *
 * `oversight-verifier` 填的就是这个洞。而它的失效方式与 `oversight-probe` 逐字相同：
 * **角色定义写得再对，SKILL.md 不派它，它就永远不会被调用**（SKILL.md §0.5 的注记
 * 记着 probe 当年正是这样：定义存在、触发条件也改过，但从没被派过）。
 *
 * ## 三层判据
 *
 *   1. **角色定义本身**：叶子（无 `Task`/`Agent`）、只核可机械验证的断言、输入是原文。
 *   2. **它在 SKILL.md 里被派发** —— 不是「被提到」。判据是「派 ... 」这种动词形态。
 *   3. **硬门真的会拦**：把 SKILL 里那一行改成「提一句但不派」，门必须变红。
 *
 * 第 3 条必须跑真身（子进程 + 临时 cwd），因为 `checkHubVerifier()` 判的对象
 * 是仓库里那两份文件的字节。从源码正则里读判据再自己比对 = 自证，本仓栽过好几次
 * （DF-039/040/042/047）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const VERIFIER = '.claude/agents/oversight-verifier.md';
const SKILL = '.claude/skills/oversight/SKILL.md';

/** 只取 frontmatter 的正文（不含 `---` 围栏）。 */
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, '缺少 frontmatter');
  return m[1];
}

// ── 1) 角色定义本身 ───────────────────────────────────────────────────

test('verifier 存在，且 frontmatter 是叶子形态：无 Task / 无 Agent', () => {
  assert.ok(existsSync(join(ROOT, VERIFIER)), 'oversight-verifier.md 不存在');
  const fm = frontmatter(read(VERIFIER));
  const tools = (fm.match(/^tools:\s*(.+)$/m) || [])[1];
  assert.ok(tools, 'frontmatter 缺 tools 整行 —— 宿主语义是「继承全部工具」');
  const list = tools.split(',').map((t) => t.trim());
  for (const d of ['Task', 'Agent']) {
    assert.ok(!list.includes(d), `tools 里有 ${d} —— 它必须是叶子，否则 §7「深度恒 1」当场失效`);
  }
});

test('verifier 的 frontmatter 写了 readonly 与 display（与其余 12 份同形）', () => {
  const fm = frontmatter(read(VERIFIER));
  assert.match(fm, /^readonly:\s*true\s*$/m, 'readonly 必须显式为 true —— 缺了硬门会报，但报在别处');
  assert.match(fm, /^display:\s*\S+/m, 'display 缺失：主线程的编队清单会显示成 id');
  // `readonly: true` + `Bash` 需要显式声明只读范围（`checkAgents()` 的规则）。
  // 这个角色是那条规则的第一个用例 —— 不写它就红了。
  assert.match(fm, /^bashScope:\s*read-only\s*$/m,
    '只读角色带 Bash 必须写 `bashScope: read-only`：不写就与「不受限的 Bash」同形');
});

test('verifier 的正文给出「允许的命令」清单（bashScope 的可核对边界）', () => {
  const t = read(VERIFIER);
  assert.match(t, /##\s*允许的命令/, '没有「## 允许的命令」一节 —— bashScope 只是一句自我声明');
  // 清单里必须至少点名这两类：跑脚本与搜源码。只有形容词的清单不可核对。
  assert.match(t, /node scripts\//, '命令清单里没有「跑本仓脚本」这一条');
  assert.match(t, /grep|rg/, '命令清单里没有搜索');
  // 反向：必须**明令禁止**写盘，否则「只读范围」是一句空话。
  assert.match(t, /不要.*改盘|不得.*改盘|会改盘的命令/, '没有禁止改盘命令 —— 只读范围没有边界');
});

test('verifier 的正文把「不核判断」写成判据，而不是一句「只核事实」', () => {
  const t = read(VERIFIER);
  // 「只核事实」是形容词，不可判定；能判的是「给出四类 + 明说判断不在其中」。
  for (const k of ['数字', '路径', '命令输出', 'grep']) {
    assert.ok(t.includes(k), `正文没有覆盖「${k}」这类断言`);
  }
  assert.match(t, /不核.*判断|判断.*没有对错可判/, '没有写清判断不在核验范围内');
  // 三值判定必须写死 —— 含糊的结论会让这份报告无法被机器读。
  for (const v of ['成立', '不成立', '无法核验']) {
    assert.ok(t.includes(v), `判定枚举缺「${v}」`);
  }
});

test('verifier 的正文要求输入是主线程输出的**原文**，不是它的自我总结', () => {
  const t = read(VERIFIER);
  assert.match(t, /原文/, '没有要求原文 —— 核一份总结等于核一个已经被人筛过一遍的东西');
  assert.match(t, /不是.*总结|不要.*总结/, '没有排除「主线程的自我总结」这个输入');
});

// ── 2) SKILL.md 真的派发它 ────────────────────────────────────────────

test('SKILL.md 在 Phase E 之前有一处**派发** oversight-verifier（不是只提名字）', () => {
  const sk = read(SKILL);
  const atVerifier = sk.indexOf('oversight-verifier');
  const atPhaseE = sk.indexOf('## 5. Phase E');
  assert.ok(atVerifier > 0, 'SKILL.md 从没提到 oversight-verifier');
  assert.ok(atPhaseE > 0, 'SKILL.md 的 Phase E 标题变了');
  assert.ok(atVerifier < atPhaseE,
    '派发点在 Phase E 之后 —— 核主线程的话必须发生在验收**之前**，'
    + '否则核出来的错已经进了交付物');
  // 派发形态：能动的是「派」这个动词，不是「名字出现过」。
  assert.match(sk, /派(?:发)?\s*(?:一个\s*)?`?oversight-verifier/,
    'SKILL.md 只提了名字，没有派发指令 —— 「名字在、从没派」正是 oversight-probe 当年落到的形态');
  // 派发必须带得动一条 compose 命令：主线程要能照着敲。
  const seg = sk.slice(Math.max(0, atVerifier - 800), atVerifier + 800);
  assert.match(seg, /compose-agent-prompt\.mjs compose/, '派发段落里没有 compose 命令 —— 主线程只能手写提示词');
});

// ── 3) 硬门真的会拦（跑真身，改副本）──────────────────────────────────

/** 复制一份仓库到临时目录，只带门需要的东西。
 *
 *  过滤规则与 `dispatch-coverage.test.mjs` / `dispatch-quartet.test.mjs` 同源：
 *  排除 `.git`（非 git 仓库时 `checkChangelog` **正确地**跳过）、产物、运行台账、
 *  临时分析目录。`.git` 必须**精确匹配**：写成 `startsWith('/.git')` 会把 `.github/` 一起排掉。 */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'ow-verifier-'));
  cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const r = src.slice(ROOT.length).replace(/\\/g, '/');
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
  // `testCount` / `importable` 各起一个子进程 import 全部测试文件（45s 超时），
  // 与本用例要验的判据**无关**。用产品自带的 `disabledChecks` 关掉它们 ——
  // 门会在输出里逐条打印「已关闭」，所以这不是偷偷少跑。
  const cfgPath = join(dir, '.untildone', 'checks.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.disabledChecks = ['testCount', 'importable'];
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  return dir;
}

/** 跑真身。环境性失败必须显式报出，不能伪装成判据通过。 */
function runGate(dir) {
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'check-structure.mjs')], {
    cwd: dir, encoding: 'utf8', timeout: 240000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.ok(r.status !== null, `硬门子进程没有正常退出（超时或被杀）—— 环境性失败：\n${out}`);
  assert.ok(out.length > 0, '硬门没有任何输出 —— 探针坏了，不能据此判任何事');
  return { status: r.status, out };
}

/** 这三条判据的报错文句。**控制组要断言「它们不出现」，变异组断言「它们出现」** ——
 *
 *  第一版控制组写的是 `assert.equal(status, 0)`（「整个仓库绿」）。那个判据**不是**
 *  本用例要证明的事，而且实测会误报：一次并行会话重构硬门配置时，本仓自身短暂不自洽
 *  （`checks.json` 里还有 `agentDir`，而 `DEFAULTS` 已经删了它），副本因此整体红，
 *  控制组跟着红 —— 而 `checkHubVerifier` 一个字都没错。
 *
 *  判据收窄到**本检查自己的那句话**之后，两个方向都仍然守得住：
 *    · 变异组：把派发/工具弄坏 → 这些文句必须出现（否则判据没工作）；
 *    · 控制组：没弄坏 → 这些文句必须**不**出现（否则判据「永远红」）。
 *  仓库别处红不红与本检查无关，不该由它来判 —— 那是别的检查的职责。
 */
const MSG_NOT_DISPATCHED = /只被提到、没被派发/;
const MSG_NEVER = /从不派发 oversight-verifier/;
const MSG_LEAF = /必须是叶子/;

test('硬门 · 对照组：未改动的副本里 checkHubVerifier 不报任何一条（否则它「永远红」）', () => {
  const dir = sandbox();
  try {
    const { out } = runGate(dir);
    for (const [re, what] of [[MSG_NOT_DISPATCHED, '没被派发'], [MSG_NEVER, '从不派发'], [MSG_LEAF, '叶子']]) {
      assert.doesNotMatch(out, re, `未改动的副本里报了「${what}」—— 那条判据是恒真的，它不判任何东西：\n${out}`);
    }
    // 硬门至少要留下一个结论行：全部通过或 N 项违规。**两条都没有**说明门崩了，
    // 而「崩了」与「通过」在只看退出码时同形（DF-047 的老病）。
    assert.match(out, /✓ .*条检查|✗ \d+ 项违规/, `门没有留下结论行 —— 它可能崩了：\n${out}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('硬门 · 把 SKILL 里的派发改成「只提一句」→ 必须红，且点名 hubVerifier 的原因', () => {
  const dir = sandbox();
  try {
    const p = join(dir, SKILL);
    const src = readFileSync(p, 'utf8');
    // 只改「派发」那一个动词，保留名字 —— 这正是 probe 的失效形态。
    const mutated = src.replace(/派(?:发)?\s*(?:一个\s*)?`?oversight-verifier/g, '（本轮不使用 oversight-verifier）');
    assert.notEqual(mutated, src, '找不到派发那一句，本用例的前提失效了');
    writeFileSync(p, mutated, 'utf8');

    const { status, out } = runGate(dir);
    assert.notEqual(status, 0, `去掉派发后门应当非零退出：\n${out}`);
    assert.match(out, MSG_NOT_DISPATCHED, `没有点名那条判据：\n${out}`);
    // 对照：另一条（「从不派发」）不该被误报 —— 名字还在，只是没有派发动词。
    assert.doesNotMatch(out, MSG_NEVER, `报错了判据分支：\n${out}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('硬门 · 两处独立变异放进同一次运行：tools 加 Agent → 「必须是叶子」；删掉引用 → 「从不派发」', () => {
  // 两条判据分支必须分开：名字完全不在（连提都没提）与名字在但没派，处置不同 ——
  // 前者是「功能被删了」，后者是「接线断了」。混成一条报错，读者不知道该去找哪一处。
  //
  // **为什么两处变异共用一次门运行**：跑一次真身约 20–30 秒（它内部还要起子进程数
  // 测试条数与 import 探针）。三次变异各跑一次会让这个文件独占 100 秒，
  // 而它与 `dispatch-coverage` / `dispatch-quartet` 的成本叠加后会让
  // `node --test scripts/` 的时长再涨一截 —— 那是本仓明确拒绝过的形态
  // （见 `dispatch-quartet.test.mjs` 的「为什么只跑一次门」）。
  //
  // 两处变异**互不干扰**：一处改角色定义的 `tools`，一处改 SKILL 里的引用。
  // 所以一次运行里两条报错都必须出现 —— 「只出现一条」会让本用例红，
  // 那正是「某条判据悄悄失效」的形态。
  const dir = sandbox();
  try {
    const vp = join(dir, VERIFIER);
    const vsrc = readFileSync(vp, 'utf8');
    const vMut = vsrc.replace(/^tools:.*$/m, 'tools: Read, Grep, Glob, Bash, Write, Agent');
    assert.notEqual(vMut, vsrc, '找不到 tools 行');
    writeFileSync(vp, vMut, 'utf8');

    const sp = join(dir, SKILL);
    const ssrc = readFileSync(sp, 'utf8');
    const sMut = ssrc.replace(/oversight-verifier/g, '（已删除的角色）');
    assert.notEqual(sMut, ssrc);
    writeFileSync(sp, sMut, 'utf8');

    const { status, out } = runGate(dir);
    assert.notEqual(status, 0, `两处变异后门应当非零退出：\n${out}`);
    assert.match(out, MSG_LEAF, `没有点名「叶子」那条判据：\n${out}`);
    assert.match(out, /Agent/, '报错没说是哪个工具');
    assert.match(out, MSG_NEVER, `没有报「从不派发」：\n${out}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
