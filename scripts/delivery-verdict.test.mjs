#!/usr/bin/env node
/**
 * delivery-verdict.test.mjs — 交付裁决函数与证据分层的回归测试。
 *
 * 守的是三件事，每条都配**回退断言**（把关键条件反过来，判据必须变假）：
 *
 *   1. **「验收 PASS 但红队阻断」是合法输入，且裁决必须是 BLOCKED。**
 *      这条不是理论：今天实测过这个形态 —— 验收判 PASS（14/14），红队判
 *      「不能交付」，两者都成立。裁决函数必须有确定的答案，不能靠人「感觉哪个对」。
 *   2. **弱证据不得替代强证据。** 这是「调用成功被当成操作成功」的唯一机械判据。
 *   3. 红队三档权限里，**缺省不是 `advisory`** —— 缺省可用就等于静默放行。
 *
 * 断言只对着一个数据结构跑，不读盘：裁决是纯函数，纯函数就该能被逐支钉死。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RT_DISPATCH, RT_SEVERITY, VERDICTS, EVIDENCE_KINDS, COVERAGE_SECTIONS,
  redteamItemProblems, isAnchored, coverageProblems, classifyEvidence,
  parseAcceptorVerdict, deliverVerdict,
} from './delivery-verdict.mjs';

// ── 夹具 ──────────────────────────────────────────────────────────────

/** 一份**合格**的红队条目。所有负向用例都从它出发，只坏一处。 */
const rtItem = (over = {}) => ({
  id: 'RT1',
  trigger: '空输入提交',
  failure: '界面开关停在旧值，日志仍报 success',
  severity: 'high',
  dispatch: 'block',
  key_path: 'K1',
  evidence: 'scripts/app/route.ts:88',
  ...over,
});

const COVERAGE_OK = [
  '我实际读了哪些文件：scripts/app/route.ts, scripts/app/state.mjs',
  '我做了哪些检查：3 个边界输入 + 2 条失效链',
  '我**没**做什么：没有跑真实 UI（本机无宿主）',
  '我无法核实的部分：跨进程重启后的状态恢复',
].join('\n');

const accMd = (rows, { conclusion = '通过', evidenceJson = null } = {}) => {
  const head = ['## 验收结论：' + conclusion, '', '| # | 判定 | 证据 | 说明 | 关键路径 |', '|---|---|---|---|---|'];
  const body = rows.map(([id, v, ev, kp]) => `| ${id} | ${v} | ${ev} | 说明 | ${kp || ''} |`);
  const tail = evidenceJson ? ['', '```evidence-json', JSON.stringify(evidenceJson), '```'] : [];
  return [...head, ...body, ...tail].join('\n');
};

const KEYS = {
  keyPaths: [{ id: 'K1', path: 'scripts/app/route.ts', why: '用户点到的那个按钮' }],
  requiredStrong: [{ key_path: 'K1', kinds: ['test'] }],
  subject: 'executor',
};

/** 一份完全合格的交付：验收 PASS + 关键路径上有可重放的强证据 + 红队只有 advisory。 */
const GOOD = () => ({
  acceptor: parseAcceptorVerdict(accMd(
    [['AC1', '通过', 'scripts/app/route.ts:88', 'K1']],
    {
      evidenceJson: [{
        id: 'E1', ac: 'AC1', key_path: 'K1', kind: 'test',
        command: 'node --test scripts/app/*.test.mjs', producedBy: 'acceptor',
      }],
    },
  )),
  redteam: {
    items: [{ ...rtItem(), dispatch: 'advisory', severity: 'low' }],
    coverage: COVERAGE_OK,
  },
  criteria: KEYS,
  deviationRefs: ['RT1'],
});

// ── 枚举本身 ──────────────────────────────────────────────────────────

test('三档权限的枚举是固定的三个值，且「accept」不是「advisory」的别名', () => {
  assert.deepEqual([...RT_DISPATCH], ['block', 'accept', 'advisory']);
  assert.ok(RT_DISPATCH.includes('accept'));
  assert.ok(RT_DISPATCH.includes('advisory'));
  // 严重度不参与阻断判定 —— 枚举与权限是两张表，混在一起会让「严重度高」自动变成阻断。
  assert.deepEqual([...RT_SEVERITY], ['high', 'medium', 'low']);
  assert.ok(VERDICTS.includes('BLOCKED'));
  assert.ok(VERDICTS.includes('FAILED'), 'FAILED 与 BLOCKED 必须分开：处置不同');
});

test('强 / 弱证据的分层是数据，不是散文', () => {
  for (const k of ['test', 'artifact', 'exit_code', 'file_content']) {
    assert.equal(EVIDENCE_KINDS[k].strong, true, `${k} 应当是强证据`);
  }
  for (const k of ['self_report', 'screenshot', 'log_paste']) {
    assert.equal(EVIDENCE_KINDS[k].strong, false, `${k} 应当是弱证据`);
  }
});

// ── 红队条目可判定性 ──────────────────────────────────────────────────

test('合格的红队条目没有 problems', () => {
  assert.deepEqual(redteamItemProblems(rtItem()), []);
});

test('回退：缺 dispatch 必须报错，且**不许**回落成 advisory（静默放行）', () => {
  const p = redteamItemProblems(rtItem({ dispatch: undefined }));
  assert.ok(p.some((x) => x.includes('dispatch')), p.join('；'));
  assert.ok(p.some((x) => x.includes('缺省不是可选值')), p.join('；'));
});

test('回退：dispatch=block 但没写 key_path 必须报错（「我说它关键它就关键」不可接受）', () => {
  const p = redteamItemProblems(rtItem({ key_path: '' }));
  assert.ok(p.some((x) => x.includes('key_path')), p.join('；'));
});

test('回退：dispatch=accept 但没写 accepted_by 必须报错（风险接受要有记录）', () => {
  const p = redteamItemProblems(rtItem({ dispatch: 'accept' }));
  assert.ok(p.some((x) => x.includes('accepted_by')), p.join('；'));
  assert.deepEqual(redteamItemProblems(rtItem({ dispatch: 'accept', accepted_by: '用户 2026-11-22' })), []);
});

test('回退：evidence 写成「见上文」不算锚点', () => {
  assert.equal(isAnchored('见上文'), false);
  assert.equal(isAnchored('明显不合理'), false);
  assert.ok(isAnchored('scripts/app/route.ts:88'));
  assert.ok(isAnchored('跑 `node --test scripts/` 得到 1933 条'));
  assert.ok(isAnchored('实测 12 次里 8 次复现'));
  const p = redteamItemProblems(rtItem({ evidence: '见上文' }));
  assert.ok(p.some((x) => x.includes('锚点')), p.join('；'));
});

test('回退：缺 id 的条目不许通过（没有编号就无法被判独立与引用）', () => {
  const p = redteamItemProblems(rtItem({ id: '' }));
  assert.ok(p.some((x) => x.includes('id')), p.join('；'));
});

// ── 覆盖声明 ──────────────────────────────────────────────────────────

test('覆盖声明四段齐全且非空 = 合格', () => {
  assert.deepEqual(coverageProblems(COVERAGE_OK), []);
  assert.equal(COVERAGE_SECTIONS.length, 4);
});

test('回退：缺任何一段都报错', () => {
  for (const sec of COVERAGE_SECTIONS) {
    const text = COVERAGE_OK.split('\n').filter((l) => !l.includes(sec)).join('\n');
    const p = coverageProblems(text);
    assert.ok(p.some((x) => x.includes(sec)), `缺「${sec}」应报：${p.join('；')}`);
  }
});

test('回退：有段名但内容是空的，必须与没写同形', () => {
  const text = COVERAGE_SECTIONS.map((s) => `${s}：`).join('\n');
  const p = coverageProblems(text);
  // 四段都在，但四段都是空的 —— 全被切成「空段」。
  assert.ok(p.length >= 4, p.join('；'));
  assert.ok(p.every((x) => x.includes('空')), p.join('；'));
});

// ── 证据强度 ──────────────────────────────────────────────────────────

test('test 类证据没有命令 = 弱证据（别人复现不了）', () => {
  const r = classifyEvidence({ kind: 'test', command: '' });
  assert.equal(r.strong, false);
  assert.ok(r.problems.some((x) => x.includes('命令')));
});

test('artifact 类证据没有字节数 = 弱证据（「生成了文件」无法核实）', () => {
  assert.equal(classifyEvidence({ kind: 'artifact', path: 'a.png' }).strong, false);
  assert.equal(classifyEvidence({ kind: 'artifact', path: 'a.png', bytes: 0 }).strong, false);
  assert.equal(classifyEvidence({ kind: 'artifact', path: 'a.png', bytes: 4096 }).strong, true);
});

test('exit_code 必须是真实数字', () => {
  assert.equal(classifyEvidence({ kind: 'exit_code' }).strong, false);
  assert.equal(classifyEvidence({ kind: 'exit_code', exitCode: 0 }).strong, true);
});

test('未知的证据类型不许当强证据用', () => {
  const r = classifyEvidence({ kind: 'vibes' });
  assert.equal(r.strong, false);
  assert.ok(r.problems.some((x) => x.includes('未知')));
});

test('回退：自证不能当强证据（producedBy 与被验对象相同）', () => {
  const r = classifyEvidence(
    { kind: 'test', command: 'node --test scripts/', producedBy: 'executor' },
    { subject: 'executor' },
  );
  assert.equal(r.strong, false, '同一支笔不能既写答案又判对错');
  assert.ok(r.problems.some((x) => x.includes('自证')));
  // 换一个生成者就成立 —— 否则上面那条只是在测「全都判假」。
  const ok = classifyEvidence(
    { kind: 'test', command: 'node --test scripts/', producedBy: 'acceptor' },
    { subject: 'executor' },
  );
  assert.equal(ok.strong, true);
});

test('截图与自述永远是弱证据，无论写得多么详细', () => {
  for (const kind of ['self_report', 'screenshot', 'log_paste']) {
    const r = classifyEvidence({ kind, path: 'x.png', bytes: 999, command: 'anything' });
    assert.equal(r.strong, false);
  }
});

// ── 验收结论解析 ──────────────────────────────────────────────────────

test('验收 PASS + 全部逐项通过 = 解析成功、无 problems', () => {
  const acc = parseAcceptorVerdict(accMd([
    ['AC1', '通过', 'scripts/a.mjs:12', 'K1'],
    ['AC2', '通过', 'scripts/b.mjs:3', ''],
  ]));
  assert.equal(acc.verdict, 'PASS');
  assert.equal(acc.items.length, 2);
  assert.deepEqual(acc.problems, []);
});

test('key_path 按表头定位，不按固定列序猜（实测过读成「说明」列）', () => {
  const acc = parseAcceptorVerdict(accMd([['AC1', '通过', 'scripts/a.mjs:12', 'K1']]));
  assert.equal(acc.items[0].key_path, 'K1', '读错列会让强证据挂在不存在的路径上');
  // 没有「关键路径」表头时**不许读 key_path** —— 那时读到的是说明列，属于猜。
  const noHeader = parseAcceptorVerdict([
    '## 验收结论：通过', '', '| # | 判定 | 证据 | 说明 |', '|---|---|---|---|',
    '| AC1 | 通过 | scripts/a.mjs:12 | 说明文字 |',
  ].join('\n'));
  assert.equal(noHeader.items[0].key_path, null);
});

test('回退：含糊结论读不出 → UNKNOWN + 报问题', () => {
  const acc = parseAcceptorVerdict('## 验收结论：基本满足\n\n| # | 判定 | 证据 |\n|---|---|---|\n| AC1 | 通过 | a.mjs:1 |');
  assert.equal(acc.verdict, 'UNKNOWN');
  assert.ok(acc.problems.some((x) => x.includes('UNKNOWN')));
});

test('回退：结论通过却一条逐项判定都没有 → 报问题（整体印象不是判定）', () => {
  const acc = parseAcceptorVerdict('## 验收结论：通过\n\n一切看起来都不错。\n');
  assert.equal(acc.verdict, 'PASS');
  assert.equal(acc.items.length, 0);
  assert.ok(acc.problems.some((x) => x.includes('整体看起来不错')));
});

test('回退：有条目判不通过却写总论「通过」→ 自相矛盾必须报', () => {
  const acc = parseAcceptorVerdict(accMd([
    ['AC1', '通过', 'a.mjs:1', 'K1'],
    ['AC2', '不通过', 'b.mjs:2', ''],
  ]));
  assert.equal(acc.verdict, 'PASS');
  assert.ok(acc.problems.some((x) => x.includes('AC2') && x.includes('自相矛盾') === false));
});

test('回退：判通过但证据列是空的 → 报问题（没找到反例不等于通过）', () => {
  const acc = parseAcceptorVerdict(accMd([['AC1', '通过', '', 'K1']]));
  assert.ok(acc.problems.some((x) => x.includes('证据列是空的')));
});

test('evidence-json 解析失败必须报问题，不能当成「没有结构化证据」', () => {
  const acc = parseAcceptorVerdict([
    '## 验收结论：通过', '', '| # | 判定 | 证据 |', '|---|---|---|', '| AC1 | 通过 | a.mjs:1 |',
    '', '```evidence-json', '{not json', '```',
  ].join('\n'));
  assert.ok(acc.problems.some((x) => x.includes('evidence-json')));
});

// ── 裁决函数四支 ──────────────────────────────────────────────────────

test('全合格 = PASS', () => {
  const r = deliverVerdict(GOOD());
  assert.equal(r.verdict, 'PASS', JSON.stringify(r));
  assert.equal(r.blocking.length, 0);
  assert.equal(r.riskUnlogged, false);
});

test('★ 验收 PASS 但红队 BLOCK → BLOCKED（两件事都成立，裁决函数给确定答案）', () => {
  const d = GOOD();
  const r = deliverVerdict(d);
  assert.equal(r.verdict, 'PASS', '前提：这份交付本来是 PASS 的');

  // 只把红队条目改成阻断，其余一个字不动。
  const blocked = deliverVerdict({
    ...d,
    redteam: { items: [rtItem()], coverage: COVERAGE_OK },
  });
  assert.equal(blocked.verdict, 'BLOCKED', '验收 PASS 不能抵消红队阻断');
  assert.ok(blocked.blocking.some((b) => b.code === 'redteam_block'));
  assert.ok(blocked.reasons.some((x) => x.includes('RT1')));
  // 回流 Phase 必须写出来，否则「然后呢」无从回答。
  assert.ok(blocked.phases.some((p) => p.startsWith('Phase E')));
  // 验收的结论仍要原样留在结果里 —— 它是事实，不是被否决的东西。
  assert.equal(blocked.acceptor === undefined, true, '裁决结果不含 acceptor 原值，由调用方保留');
});

test('★ key_path 不在预声明清单里的「阻断」不能放行（「关键」必须预先声明）', () => {
  const d = GOOD();
  const r = deliverVerdict({
    ...d,
    redteam: { items: [rtItem({ key_path: 'K9' })], coverage: COVERAGE_OK },
  });
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(r.blocking.some((b) => b.code === 'key_path_undeclared'));
  assert.ok(r.phases.some((p) => p.includes('Phase A')));
});

test('红队条目本身判不了（缺 dispatch）→ BLOCKED，不许当成「没有阻断项」', () => {
  const d = GOOD();
  const r = deliverVerdict({
    ...d,
    redteam: { items: [rtItem({ dispatch: undefined })], coverage: COVERAGE_OK },
  });
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(r.blocking.some((b) => b.code === 'redteam_malformed'));
});

test('验收 FAILED → FAILED（不是 BLOCKED：处置是修复后重验，不是补采样）', () => {
  const d = GOOD();
  const r = deliverVerdict({
    ...d,
    acceptor: parseAcceptorVerdict(accMd([['AC1', '不通过', 'a.mjs:1', 'K1']], { conclusion: '不通过' })),
    redteam: { items: [], coverage: COVERAGE_OK },
  });
  assert.equal(r.verdict, 'FAILED');
  assert.ok(r.blocking.every((b) => b.code === 'accept_not_pass'));
});

test('★ 关键路径上只有弱证据 → BLOCKED（这就是「调用成功当成操作成功」）', () => {
  const d = GOOD();
  // 把唯一的强证据换成截图：其余一切不变，结论必须翻转。
  const weakAcc = parseAcceptorVerdict(accMd(
    [['AC1', '通过', '截图已附', 'K1']],
    { evidenceJson: [{ id: 'E1', ac: 'AC1', key_path: 'K1', kind: 'screenshot', path: 'a.png', bytes: 999 }] },
  ));
  assert.deepEqual(weakAcc.problems, [], '截图本身不构成验收问题——它是弱证据，不是无效证据');
  const r = deliverVerdict({ ...d, acceptor: weakAcc });
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(r.blocking.some((b) => b.code === 'weak_replaces_strong'));
});

test('requiredStrong 写了但没有强类型 → BLOCKED（配置本身在要求弱证据）', () => {
  const d = GOOD();
  const r = deliverVerdict({
    ...d,
    criteria: { ...KEYS, requiredStrong: [{ key_path: 'K1', kinds: ['self_report'] }] },
  });
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(r.blocking.some((b) => b.code === 'strong_req_weak'));
});

test('requiredStrong 指向未声明路径 → BLOCKED（强证据要求不能挂在事后发明的路径上）', () => {
  const d = GOOD();
  const r = deliverVerdict({
    ...d,
    criteria: { ...KEYS, requiredStrong: [{ key_path: 'K8', kinds: ['test'] }] },
  });
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(r.blocking.some((b) => b.code === 'strong_req_undeclared'));
});

test('红队清单为空且无覆盖声明 → BLOCKED（「没发现」与「没查」必须分得开）', () => {
  const d = GOOD();
  const r = deliverVerdict({ ...d, redteam: { items: [], coverage: '' } });
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(r.blocking.some((b) => b.code === 'redteam_no_coverage'));
});

test('红队清单为空但有完整覆盖声明 → 可以 PASS（空清单本身是合法结论）', () => {
  const d = GOOD();
  const r = deliverVerdict({ ...d, redteam: { items: [], coverage: COVERAGE_OK } });
  assert.equal(r.verdict, 'PASS', JSON.stringify(r));
});

test('advisory 未登记台账 → 仍 PASS，但带上 riskUnlogged 标记', () => {
  const d = GOOD();
  const r = deliverVerdict({ ...d, deviationRefs: [] });
  assert.equal(r.verdict, 'PASS', '风险不阻断交付');
  assert.equal(r.riskUnlogged, true, '但「记录在案」与「没人看见」必须分得开');
  assert.ok(r.reasons.some((x) => x.includes('risk_unlogged')));
});

test('accept 档不阻断，但必须点名接受者；结果里留下记录', () => {
  const d = GOOD();
  const r = deliverVerdict({
    ...d,
    redteam: { items: [rtItem({ dispatch: 'accept', accepted_by: '用户 scoping 决定，2026-11-22' })], coverage: COVERAGE_OK },
  });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.risky.length, 1);
  assert.ok(r.risky[0].detail.includes('接受'), JSON.stringify(r.risky));
});

test('回退：裁决不是加权平均 —— 严重度高但 dispatch=advisory 就不阻断', () => {
  const d = GOOD();
  const r = deliverVerdict({
    ...d,
    redteam: { items: [rtItem({ dispatch: 'advisory', severity: 'high' })], coverage: COVERAGE_OK },
  });
  assert.equal(r.verdict, 'PASS', '严重度是红队的主观量，不能偷换成权限');
});

test('回退：严重度低但 dispatch=block 仍然阻断', () => {
  const d = GOOD();
  const r = deliverVerdict({
    ...d,
    redteam: { items: [rtItem({ severity: 'low' })], coverage: COVERAGE_OK },
  });
  assert.equal(r.verdict, 'BLOCKED');
});

test('空输入不会崩，且判 UNKNOWN 相关的 BLOCKED（不是静默 PASS）', () => {
  const r = deliverVerdict({});
  assert.notEqual(r.verdict, 'PASS');
  assert.equal(r.verdict, 'BLOCKED');
});
