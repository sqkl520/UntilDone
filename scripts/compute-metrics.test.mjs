#!/usr/bin/env node
/**
 * compute-metrics.test.mjs — 指标计算器的**判据**是可验的，且失效方向已知。
 *
 * 这个脚本的产出会被当成「框架有没有用」的数字引用，所以它最坏的失效不是崩，
 * 而是**安静地算出一个看起来合理的数**。三种具体形态，每一种在这里都有对应用例：
 *
 *  ① **「算不出来」退化成一个数**。若不可算的指标返回 `0` 而不是 `null`，
 *    下游会把它当「比率是 0%」引用。用例钉住：不可算时 `computable==='no'`
 *     且 headline 里带「不可算」。
 *  ② **小样本被当成率**。`3/3 = 100%` 看起来像结论。用例钉住：分母 < 30 的比率
 *     文本必须带「样本量不足以支撑结论」。
 *  ③ **重复记录被当成多干活**。同一次 API 响应被拆成多条 assistant 记录、
 *     每条重复带同一份 `usage`。用例钉住：`foldUsage` 对同一个 `message.id`
 *     只计一次，且**取非 0 的那条**（实测本仓 5,177 个 id 是「0 与非 0 并存」）。
 *
 * 另外还有两条本仓特有的失效：
 *  ④ **引用格式被当成产出**。`## 验收结论：…` 出现在 `tool_result`（引用了文档）
 *     或 `tool_use` 的写入正文（正在写角色定义）里，都不是「产出了结论」。
 *  ⑤ **按时间排链**。`50ec242b` 的 r2 最后才完成，按时间排会得出一条假的
 *     「不通过 → 不通过 → 通过 → 通过」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MIN_N_FOR_RATE, DEDUPE_KEYS, foldUsage, parseAnchor, checkC2, findVerdicts,
  declaredOrdinal, claimsPriorFail, acSetOf, verdictChains, attemptsToPass,
  buildReport, formatReport, parseArgs,
} from './compute-metrics.mjs';

const CLI = join(import.meta.dirname, 'compute-metrics.mjs');

// ── 构造语料 ──────────────────────────────────────────────────────────

/** 一条 assistant 记录。`usage` 与 `id` 用来验去重。 */
const asst = (id, billable, { calls = [], text = null, ts = null, extra = {} } = {}) => ({
  type: 'assistant',
  timestamp: ts,
  attributionAgent: extra.attributionAgent || undefined,
  message: {
    id,
    usage: {
      input_tokens: billable,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    },
    content: [
      ...(text != null ? [{ type: 'text', text }] : []),
      ...calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name || 'Read', input: c.input || {} })),
    ],
  },
});

const userText = (text) => ({ type: 'user', message: { content: text } });
const toolResult = (text) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: text }] } });

// ── ① 不可算不许退化成 0 ──────────────────────────────────────────────

test('不可算的指标返回 null 与「不可算」，不是 0', () => {
  const rep = buildReport({ m1: null, mv: null, m3: null, m3r: null, cs: null });
  const m5 = rep.metrics.find((m) => m.id === 5);
  assert.equal(m5.computable, 'no');
  assert.match(m5.headline, /不可算/);
  // 关键：没有「收敛链」时，first_pass 的分母是 0、pct 是 null —— **不是 0%**。
  assert.equal(m5.firstPass.pct, null, '分母为 0 时 pct 必须是 null，写成 0 会被读成「成功率 0%」');
  assert.match(m5.firstPass.text, /分母为 0/);
});

test('分母为 0 的比率打成「—（分母为 0）」而不是 0%', () => {
  const rep = buildReport({ m1: { runs: [], attributed: 0, proxied: 0, totalTasks: 0 } });
  const m1 = rep.metrics.find((m) => m.id === 1);
  assert.equal(m1.attribution.nonce.text, '—（分母为 0）');
});

// ── ② 小样本必须被标注 ────────────────────────────────────────────────

test(`分母 < ${MIN_N_FOR_RATE} 的比率必须标「样本量不足以支撑结论」`, () => {
  const rep = buildReport({
    m1: { runs: [], attributed: 0, proxied: 0, totalTasks: 0 },
    m3: { tasks: 1, anchoredAcTotal: 5, inOutputs: 4, violations: [] },
  });
  const m3 = rep.metrics.find((m) => m.id === 3);
  assert.equal(m3.c2.denominator, 5);
  assert.equal(m3.c2.smallSample, true);
  assert.match(m3.c2.text, /样本量不足以支撑结论/);
});

test('大样本不标注（否则这句提示会因为到处都是而失效）', () => {
  const rep = buildReport({
    m1: { runs: [], attributed: 0, proxied: 0, totalTasks: 0 },
    m3: { tasks: 100, anchoredAcTotal: 100, inOutputs: 80, violations: [] },
  });
  const m3 = rep.metrics.find((m) => m.id === 3);
  assert.equal(m3.c2.smallSample, false);
  assert.doesNotMatch(m3.c2.text, /样本量不足/);
});

// ── ③ 去重：同一 message.id 只算一次，且取非 0 ─────────────────────────

test('同一 message.id 的多条记录只计一次 token（流式记录不许重复计）', () => {
  const recs = [
    asst('m1', 100),
    asst('m1', 100),
    asst('m1', 100),
  ];
  const f = foldUsage(recs);
  assert.equal(f.billableTokens, 100, '三次记录是同一份 usage，只该算 100');
  assert.equal(f.messageIds, 1);
});

test('同一 message.id 的「0 与非 0 并存」必须取非 0（取第一条会取到 0）', () => {
  // 实测本仓 5,177 个 id 是这个形态：前几条是流式占位（usage 全 0），最后一条才带数。
  const recs = [asst('m1', 0), asst('m1', 0), asst('m1', 250)];
  const f = foldUsage(recs);
  assert.equal(f.billableTokens, 250, '取第一条会得到 0 —— 那会把整批 token 吃掉');
  assert.equal(f.ambiguousUsageIds, 0, '只有一个非 0 值，不算歧义');
});

test('多个不同的非 0 值记为歧义，并取最大（不低估）', () => {
  const recs = [asst('m1', 100), asst('m1', 300), asst('m1', 200)];
  const f = foldUsage(recs);
  assert.equal(f.ambiguousUsageIds, 1);
  assert.equal(f.billableTokens, 300, '歧义时取最大，取最小或平均都是猜');
});

test('调用数按 tool_use.id 去重', () => {
  const recs = [
    asst('m1', 10, { calls: [{ id: 'c1' }, { id: 'c2' }] }),
    asst('m1', 10, { calls: [{ id: 'c1' }, { id: 'c2' }] }),
  ];
  const f = foldUsage(recs);
  assert.equal(f.calls, 2, '同一批 tool_use 被记了两遍，仍是 2 次调用');
  assert.equal(f.dedupe.tokens, 'message.id');
  assert.equal(f.dedupe.calls, 'tool_use.id');
});

test('cache_read 单列，不进计费 token', () => {
  const r = asst('m1', 100);
  r.message.usage.cache_read_input_tokens = 9999;
  const f = foldUsage([r]);
  assert.equal(f.billableTokens, 100, 'cache_read 不该被加进计费 token');
  assert.equal(f.cacheReadTokens, 9999, '但它必须出现在单列里');
});

// ── ④ 引用格式 ≠ 产出 ─────────────────────────────────────────────────

test('assistant 正文里的验收结论算产出', () => {
  const v = findVerdicts([asst('m1', 1, { text: '## 验收结论：通过\n\n全部达标。' })]);
  assert.equal(v.asAssistant.length, 1);
  assert.equal(v.asAssistant[0].verdict, '通过');
});

test('tool_result 里出现的验收结论不算本次产出（那可能只是引用了文档）', () => {
  const v = findVerdicts([toolResult('```\n## 验收结论：通过 / 不通过\n```')]);
  assert.equal(v.asAssistant.length, 0);
  assert.equal(v.quotedInResult.length, 1);
});

test('写文件的正文里出现验收结论不算产出（那是在写角色定义）', () => {
  const rec = asst('m1', 1, { calls: [{ id: 'w1', name: 'Write', input: { file_path: 'x.md', content: '## 验收结论：通过 / 不通过' } }] });
  const v = findVerdicts([rec]);
  assert.equal(v.asAssistant.length, 0);
  assert.equal(v.quotedInWrite.length, 1);
});

test('宽松匹配不算：只有 `## 验收结论：` 开头才算', () => {
  const v = findVerdicts([asst('m1', 1, { text: '我的验收结论是：通过了。' })]);
  assert.equal(v.asAssistant.length, 0, '正文里提到这四个字不算 —— 那正是 DF-076 那种误判的成因');
});

// ── AC anchor（指标 3 的 C2 / C1）─────────────────────────────────────

test('只有 `file:line` 形态才算 anchor；散文不算', () => {
  assert.deepEqual(parseAnchor('scripts/x.mjs:40'), { file: 'scripts/x.mjs', line: 40 });
  assert.equal(parseAnchor('测试用例'), null);
  assert.equal(parseAnchor('grep 无 fs 调用'), null);
});

test('C2：AC 指向的文件不在该子树 outputs 内，是一条真违规', () => {
  const g = {
    subtrees: [
      { id: 'T1', outputs: ['a.mjs'], acceptance: [{ id: 'AC1', evidence: 'a.mjs:1' }] },
      { id: 'T2', outputs: ['b.mjs'], acceptance: [{ id: 'AC1', evidence: 'c.mjs:9' }] },
    ],
  };
  const r = checkC2(g);
  assert.equal(r.anchoredAcTotal, 2);
  assert.equal(r.inOutputs, 1);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].task, 'T2');
  assert.equal(r.violations[0].file, 'c.mjs');
});

test('C2：没有 anchor 的 AC 不进分母（不能算成「通过」）', () => {
  const g = { subtrees: [{ id: 'T1', outputs: ['a.mjs'], acceptance: [{ id: 'AC1', evidence: '测试用例' }] }] };
  const r = checkC2(g);
  assert.equal(r.anchoredAcTotal, 0, '读不出 anchor 就是 0 个，不是 1 个通过');
});

// ── ⑤ 链：顺序与分组 ─────────────────────────────────────────────────

test('declaredOrdinal 读得出「第三次验收（r3）」与「（r4）」两种写法', () => {
  assert.equal(declaredOrdinal('这是**第三次验收**（r3）。'), 3);
  assert.equal(declaredOrdinal('这是**第四次验收**（r4）。'), 4);
  assert.equal(declaredOrdinal('你有一票否决权。'), null);
});

test('claimsPriorFail 认得 r2 对 r1 的显式回指', () => {
  assert.equal(claimsPriorFail('第一次验收（r1）判**不通过**，两条阻断问题：'), true);
  assert.equal(claimsPriorFail('你有一票否决权。'), false);
});

test('acSetOf 抽出 AC 编号集合，用来把同会话里的两套标准分开', () => {
  const a = acSetOf('AC1、AC2、AC3、AC4、AC5、AC6、AC7、AC8、AC9');
  const b = acSetOf('AC1、AC2、AC3、AC4、AC5、AC6、AC7、AC8、AC9、AC10、AC11、AC12');
  assert.equal(a.size, 9);
  assert.equal(b.size, 12);
  // 同一个编号出现两次只算一次（表头与正文都会出现 AC1）。
  assert.equal(acSetOf('AC1 | AC1 | AC2').size, 2);
});

/** 造一份子 agent transcript 应有的最小记录集：首条 user 带声明轮次，末尾 assistant 带结论。 */
const round = (session, ord, verdict, { acs = 9, claimsR1 = false } = {}) => {
  const acLine = Array.from({ length: acs }, (_, i) => `AC${i + 1}`).join('、');
  const head = (ord != null ? `这是**第${['', '一', '二', '三', '四', '五'][ord]}次验收**（r${ord}）。\n` : '')
    + (claimsR1 ? '第一次验收（r1）判**不通过**。\n' : '')
    + `判据：${acLine}\n`;
  return {
    file: `/tmp/projects/slug/${session}/subagents/agent-r${ord || 1}.jsonl`,
    records: [userText(head), asst('m', 1, { text: `## 验收结论：${verdict}\n` })],
  };
};

test('链按声明的轮次排，不按完成时间排（50ec242b 的 r2 最后才完成）', () => {
  // r2 的 transcript 在时间上最后，但它的声明轮次是 r2 —— 必须排第二。
  const transcripts = [
    { ...round('s1', 1, '不通过'), records: [userText('这是**第一次验收**？不，r1 不自报\n判据：AC1、AC2'), asst('m', 1, { text: '## 验收结论：不通过\n', ts: '2026-01-01T00:00:00Z' })] },
    { ...round('s1', 3, '不通过'), records: [userText('这是**第三次验收**（r3）。判据：AC1、AC2'), asst('m', 1, { text: '## 验收结论：不通过\n', ts: '2026-01-01T01:00:00Z' })] },
    { ...round('s1', 4, '通过'), records: [userText('这是**第四次验收**（r4）。判据：AC1、AC2'), asst('m', 1, { text: '## 验收结论：通过\n', ts: '2026-01-01T02:00:00Z' })] },
    // r2 完成得最晚
    { ...round('s1', 2, '通过'), records: [userText('这是**第二次验收**（r2）。判据：AC1、AC2'), asst('m', 1, { text: '## 验收结论：通过\n', ts: '2026-01-01T03:00:00Z' })] },
  ];
  const chains = verdictChains(transcripts);
  assert.equal(chains.length, 1);
  assert.deepEqual(chains[0].verdicts, ['不通过', '通过', '不通过', '通过'], '按时间排会得到 不通过→不通过→通过→通过（假的）');
});

test('同会话里两套不同 AC 标准必须分成两条链（否则会串成一条假链）', () => {
  const transcripts = [
    { file: '/tmp/projects/slug/s2/subagents/a.jsonl', records: [userText('AC1、AC2、AC3'), asst('m', 1, { text: '## 验收结论：不通过\n' })] },
    { file: '/tmp/projects/slug/s2/subagents/b.jsonl', records: [userText('AC1、AC2、AC3、AC4'), asst('m', 1, { text: '## 验收结论：通过\n' })] },
  ];
  const chains = verdictChains(transcripts);
  assert.equal(chains.length, 2, '10 项与 12 项两套标准是两个任务，不是一条链的两轮');
});

test('attemptsToPass 只认序号 1..N 连续、且以 PASS 收尾的链', () => {
  const good = { session: 'a', count: 2, verdicts: ['不通过', '通过'], declaredOrdinals: [null, '2'], contiguousFromOne: true, linkedByBackref: false, endsInPass: true, method: 'ordinals-1..N' };
  const bad = { session: 'b', count: 2, verdicts: ['不通过', '不通过'], declaredOrdinals: [null, '2'], contiguousFromOne: true, linkedByBackref: false, endsInPass: false, method: 'ordinals-1..N' };
  const r = attemptsToPass([good, bad]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].attempts, 2);
  assert.equal(r.censored.length, 1, 'censored 必须同表出现，不许从分母里悄悄去掉');
});

test('「通过后又判不通过」被记成 passThenFail 候选', () => {
  const transcripts = [
    { file: '/tmp/projects/slug/s3/subagents/a.jsonl', records: [userText('AC1'), asst('m', 1, { text: '## 验收结论：通过\n' })] },
    { file: '/tmp/projects/slug/s3/subagents/b.jsonl', records: [userText('这是**第二次验收**（r2）。AC1'), asst('m', 1, { text: '## 验收结论：不通过\n' })] },
  ];
  const chains = verdictChains(transcripts);
  assert.equal(chains[0].verdicts[0], '通过');
  assert.equal(chains[0].verdicts[1], '不通过');
  assert.equal(chains[0].passThenFail, true);
});

// ── 渲染与 CLI ────────────────────────────────────────────────────────

test('formatReport 里每个比率都与它的 n 同表出现', () => {
  const rep = buildReport({
    m1: { runs: [], attributed: 0, proxied: 0, totalTasks: 0 },
    m3: { tasks: 1, anchoredAcTotal: 5, inOutputs: 4, violations: [] },
  });
  const text = formatReport(rep);
  assert.match(text, /4\/5 = 80%/, '比率必须写成「分子/分母 = 百分比」');
});

test('--json 输出的 comp 数字来自报告本体，不是另算一遍', () => {
  const d = mkdtempSync(join(tmpdir(), 'ow-metrics-'));
  try {
    // 空根：transcript 一份都没有。脚本必须正常退出 0（「没有数据」不是故障）。
    const r = spawnSync(process.execPath, [CLI, '--root', d, '--json'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.ok(Array.isArray(j.metrics));
    assert.equal(j.metrics.length, 5);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('找不到 transcript 根时 exit 2，并明说「看不到」而不是「没有数据」', () => {
  const r = spawnSync(process.execPath, [CLI, '--root', join(tmpdir(), 'ow-does-not-exist-xyz')], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 2);
  assert.match(`${r.stdout}${r.stderr}`, /看不到/);
});

test('parseArgs 认四个参数', () => {
  assert.deepEqual(parseArgs(['--days', '7', '--json']), { days: 7, json: true, session: null, root: null, quiet: false });
  assert.equal(parseArgs(['--session', 'x']).session, 'x');
  assert.equal(parseArgs(['--root', 'y']).root, 'y');
});
