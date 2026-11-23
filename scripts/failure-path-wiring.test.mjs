#!/usr/bin/env node
/**
 * failure-path-wiring.test.mjs — 「失败处理的两条路径」有没有真的接进流程。
 *
 * ## 为什么这份测试必须存在（不只是「文档写了就够了」）
 *
 * 契约 §8 定了一条**默认值**：失败先走盲重采样（丢弃失败输出，从原始任务契约重派
 * 新实例），只有「可定位的局部修复」才交给 repair。这条默认值的失效方式不是报错，
 * 是**悄悄退回原样** ——
 *
 *   · SKILL.md 的 Phase E 改回「不通过 → repair」：流程回到旧形态，没人会注意到；
 *   · `oversight-repair` 的 description 改回「验收不通过时触发」：它的触发条件又会
 *     在每一次失败时命中；
 *   · 契约 §8.2 的「不许喂失败内容」被删掉：`--prior-failure` 就能重新变成锚定源。
 *
 * 三种都是**文档级删除**，任何别的测试都不会红。本仓的历史里，这类行最容易被
 * 下一次重构「顺手简化掉」（`reconciliation-wiring.test.mjs` 的头注释记的是同一件事）。
 *
 * ## 每条都配回退断言
 *
 * 只断言「现在有」的测试挡不住下次重构。这里对每一组都真的删一次、再断言判据变假——
 * 删的对象是本文件自己造出来的字符串，不修改磁盘上的真实文件。
 *
 * 机械判据那一半（`failureNoticeProblem` / CLI 接线）在 `compose-agent-prompt.test.mjs` 里，
 * 因为它测的是同一份源码。这一份只守**流程文档与角色定义**：那部分没有函数可测。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const CONTRACT = 'docs/spec/dispatch-contract.md';
const SKILL = '.claude/skills/oversight/SKILL.md';
const REPAIR = '.claude/agents/oversight-repair.md';
const DISPATCH = 'templates/dispatch.md';

/** 从 SKILL.md 里取出 Phase E 那一段（到 Phase F 之前）。
 *
 *  只断言「文件里某处提到盲重采样」是不够的：那句话可能被放在附录里，
 *  而 Phase E 仍然是「不通过 → repair」。判据必须**落在流程所在的那一段**。 */
function phaseE(text) {
  const i = text.indexOf('## 5. Phase E');
  assert.ok(i > 0, 'SKILL.md 的 Phase E 标题变了：找不到参照点');
  const j = text.indexOf('## 6. Phase F', i);
  assert.ok(j > i, 'SKILL.md 的 Phase F 标题变了：Phase E 段落无法界定');
  return text.slice(i, j);
}

// ── 契约 §8：两条路径 + 可判定判据 ──────────────────────────────────────

test('契约有 §8，且写清「默认路径是盲重采样，不是 repair」', () => {
  const t = read(CONTRACT);
  assert.match(t, /## 8\. 失败处理/, '契约里没有 §8 —— SKILL / repair / 模板的引用会指向不存在的地方');
  assert.match(t, /盲重采样是默认|默认路径.{0,10}盲重采样|默认.{0,12}盲重采样/,
    '没有说清默认路径是盲重采样');
  // 与旧形态的对立必须显式写出来，否则读者会按旧习惯理解
  assert.match(t, /为什么默认不是「交给 repair 去修」|不是「交给 repair/,
    '没有解释为什么默认不再是 repair —— 只写新规则不写它取代了什么，下一个人会两套都保留');
});

test('契约 §8.3 的三个准入条件都是可判定的（有 file:line / outputs / nonce 的具体判据）', () => {
  const t = read(CONTRACT);
  const s = t.slice(t.indexOf('### 8.3'), t.indexOf('### 8.4'));
  assert.ok(s.length > 0, '找不到 §8.3');
  assert.match(s, /C1/, '缺少 C1');
  assert.match(s, /C2/, '缺少 C2');
  assert.match(s, /C3/, '缺少 C3');
  // 三条判据各自的机械形态——只写代号不写判据等于没有准入条件
  assert.match(s, /file:line/, 'C1 没有给出定位的具体形态');
  assert.match(s, /outputs/, 'C2 没有把「局部」绑到产出清单上');
  assert.match(s, /nonce/, 'C3 没有给出「是新实例」的机械判据');
});

test('契约 §8.4 规定「可定位性」由 Hub 判，且不许失败实例自报', () => {
  const t = read(CONTRACT);
  const s = t.slice(t.indexOf('### 8.4'), t.indexOf('### 8.5'));
  assert.ok(s.length > 0, '找不到 §8.4');
  assert.match(s, /由 Hub 判|Hub（主线程）判|由 Hub/,
    '没有写清谁判「可定位」——不写就会落回「谁想修谁判」');
  assert.match(s, /不许.{0,20}自报|不得.{0,20}自报|自报「我能修」/,
    '没有禁止失败实例自报「我能修」——那正是锚定的入口');
});

test('契约 §8.6 如实列出哪条判不了（不许用「应该」含混过去）', () => {
  const t = read(CONTRACT);
  const s = t.slice(t.indexOf('### 8.6'));
  assert.ok(s.length > 0, '找不到 §8.6');
  assert.match(s, /\*\*不能\*\*|不能机械判|目前无法机械判定/, '§8.6 必须如实标出不可机械判的项');
  // 这一节的对照面：可判的项也要列出来。只列「判不了」会退化成免责声明。
  assert.match(s, /\*\*能\*\*|\*\*能（弱）\*\*/, '§8.6 没有列出可判项 —— 只列判不了就变成了免责声明');
});

// ── SKILL.md 的 Phase E ────────────────────────────────────────────────

test('SKILL.md 的 Phase E 段内写的是两条路径，不是「不通过 → repair」', () => {
  const s = phaseE(read(SKILL));
  // 判据要落在**决定**那一句上：`/盲重采样/` 在整个段里到处出现（次数上限、理由段都有），
  // 用它当判据的话，回退那一句时判据照样命中 —— 那是假绿（第一版就是这么错的）。
  assert.match(s, /任一条不满足\s*→\s*盲重采样/, 'Phase E 里没有「不满足 → 盲重采样」这个决定');
  assert.match(s, /三条全满足\s*→\s*局部修复|局部修复（例外路径）/, 'Phase E 里没有局部修复这一条例外');
  // 旧形态的原样：不通过就直接交给 repair
  assert.doesNotMatch(s, /不通过 → `oversight-repair` → \*\*完整重新验收/,
    'Phase E 还是旧形态（不通过 → repair）—— 契约 §8 没有接进流程');
});

test('SKILL.md 的 Phase E 段内给出 C1/C2/C3 的判据，而不只是「判一下能不能修」', () => {
  const s = phaseE(read(SKILL));
  for (const c of ['C1', 'C2', 'C3']) {
    assert.ok(s.includes(c), `Phase E 里缺少 ${c} —— 主线程拿到的是「判一下」而不是判据`);
  }
  assert.match(s, /file:line/, 'Phase E 没有要求定位落到 file:line');
});

test('SKILL.md 的 Phase E 段内禁止用 --prior-failure 传失败内容', () => {
  const s = phaseE(read(SKILL));
  assert.match(s, /不要用 `--prior-failure`|不得.{0,10}--prior-failure/,
    '没有禁 --prior-failure —— compose 会拦，但流程不写就没人知道该传什么');
  assert.match(s, /原因类别/, '没有给出允许传的那一句的形态（原因类别枚举）');
});

test('SKILL.md 写明了「盲重采样最多 2 次、总共最多 3 次」', () => {
  const s = phaseE(read(SKILL));
  assert.match(s, /最多.{0,4}3/, '没有轮次上限');
  assert.match(s, /盲重采样最多\s*2\s*次/, '没有给盲重采样单独的次数上限——它会撞上总上限而没有换策略的机会');
});

// ── repair 角色：只在可定位时接手 ──────────────────────────────────────

test('repair 的 description 说明它只在可定位的局部修复路径上触发', () => {
  const t = read(REPAIR);
  const fm = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(fm, 'repair 缺少 frontmatter');
  assert.match(fm[1], /可定位|局部修复/, 'description 没有限定触发条件是「可定位」—— 它会继续在每次失败时触发');
  assert.match(fm[1], /盲重采样|不是本角色/, 'description 没有说清默认路径不是它');
});

test('repair 的正文要求它先核对 C1/C2/C3，缺一条就停下来', () => {
  const t = read(REPAIR);
  assert.match(t, /先确认你该不该在这里/, '没有让它在开工前核对准入条件');
  for (const c of ['C1', 'C2', 'C3']) assert.ok(t.includes(c), `repair 正文缺少 ${c}`);
  assert.match(t, /停下来|应走盲重采样/, '没有给出「不满足时怎么办」');
});

test('repair 不接收也不复用失败实例的输出', () => {
  const t = read(REPAIR);
  assert.match(t, /不会给你|不会拿到/, '没有写清它不会收到失败输出');
  assert.match(t, /忽略它们/, '看到了被禁止的内容时没有给动作 —— 只靠「请勿读」不是约束');
  // 输入清单必须落在「定位结论」上，不是「验收理由 + 锐评意见」（那是旧形态）
  assert.match(t, /定位结论/, '输入里没有「定位结论」——它还在按旧的「验收理由」工作');
});

// ── 派发模板：无内容通知的形态 ─────────────────────────────────────────

test('派发模板明写「重派只收到一句无内容通知」，不是「上次失败模式」', () => {
  const t = read(DISPATCH);
  assert.match(t, /无内容/, '模板里没有无内容通知这个概念 —— 子 agent 会以为重派会拿到失败细节');
  assert.doesNotMatch(t, /作为负面约束/, '模板还在教「上次失败模式作为负面约束」——那就是锚定源');
});

// ── 回退断言：把每条关键行真的删掉，判据必须变假 ────────────────────────

test('回退：把 SKILL 的「任一条不满足 → 盲重采样」换掉，Phase E 判据必须变红', () => {
  const original = read(SKILL);
  const old = original.replace('任一条不满足 → 盲重采样', '任一条不满足 → 交给 oversight-repair');
  assert.notEqual(old, original, '找不到那句锚点，回退无法进行');
  const s = phaseE(old);
  assert.doesNotMatch(s, /任一条不满足\s*→\s*盲重采样/,
    '删掉之后判据仍然通过 —— 这条测试没有守住那一句');
});

test('回退：把 repair description 的「只在可定位的局部修复」改回旧触发条件，判据必须变假', () => {
  const original = read(REPAIR);
  const old = original.replace(/只在「可定位的局部修复」路径上接手/, '仅在验收不通过或锐评低于阈值时触发');
  assert.notEqual(old, original, '找不到那句锚点');
  const fm = old.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.doesNotMatch(fm[1], /只在「可定位的局部修复」路径上接手/, '改回旧触发条件后判据仍然通过');
});

test('回退：把契约 §8 的 C1 判据里的 file:line 删掉，§8.3 判据必须变假', () => {
  const t = read(CONTRACT);
  const s0 = t.slice(t.indexOf('### 8.3'), t.indexOf('### 8.4'));
  const mutated = t.replace(/\{file, line\}/g, '').slice(t.indexOf('### 8.3'), t.indexOf('### 8.4'));
  assert.notEqual(mutated, s0, '找不到那处判据形态');
  assert.doesNotMatch(mutated, /\{file, line\}|file,line/, '删掉之后判据仍然通过');
});
