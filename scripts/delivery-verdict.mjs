#!/usr/bin/env node
/**
 * delivery-verdict.mjs — 「这份交付能不能发」的唯一实现。
 *
 * ## 它治的是什么
 *
 * 本仓曾经（并且在别的项目里正在反复）出现一个伪完成形态：
 *
 *     Agent 点完按钮，日志返回 `success`，测试也绿了，但**界面开关仍然没有变化**——
 *     因为原测试只断言「调用没抛异常」，没有断言界面真实状态改变。
 *
 * 一句话根因：**「调用成功」被当成了「操作成功」。**
 *
 * 这里的第二个形态同样真实：**验收判 PASS、红队判「不能交付」，两者都成立。**
 * 验收判的是**预声明标准**（AC1..ACn 逐条核对），红队找的是**标准之外**的东西
 * （边界、失效链、假设崩塌）。它们不是同一个函数的两份输入，不可能互相取代。
 *
 * 于是「最后听谁的」如果靠人「感觉哪个对」，就等于没有裁决 —— 而没有一个显式函数，
 * 这类分歧每次都会以不同的方式被解决一遍，且每次都不可复现。
 *
 * ## 三档权限，以及与验收的关系
 *
 * | dispatch   | 含义                              | 能不能交付 |
 * |------------|-----------------------------------|-----------|
 * | `block`    | 已核实、落在关键路径上            | **否**，进 FAILED |
 * | `accept`   | 已知风险，用户/主线程显式接受      | 能，但必须留记录 |
 * | `advisory` | 标准之外的风险提示                 | 能，记录风险 |
 *
 * 「验收 PASS 但红队 BLOCK」在本文件里是一个**合法的输入**，不是矛盾：
 * 裁决函数对它给出 `BLOCKED`，并把两组结论都原样留下。反过来（验收 FAIL、
 * 红队没发现问题）也合法 —— 那不是红队失职，是它负责的面本来不同。
 *
 * ## 为什么是纯函数
 *
 * 裁决会被三类调用方用：`validate-run` 的派发前校验、`compose` 派出红队时写进
 * 提示词的**预先声明**、以及收活流程（本文件的 CLI）。`deliverVerdict()` 本身
 * 必须能被单测逐个分支钉死，所以它不读盘、不看时钟、不读环境变量。
 * 读盘/解析报告的部分在**本文件底部**（`parseRedteamReport` / `main`），
 * 它们是能力的入口，不是裁决本身 —— 把两者混在一起，裁决就再也无法被逐支钉死。
 *
 * 零依赖。
 */

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 红队裁决的三档。**顺序无关**，判据是标签本身。
 *
 *  为什么必须有第三档（`accept`）：只有两档时，「我知道这个风险、我接受」
 *  只能被写成「不阻断」，而那与「我没看见」在屏幕上同形。第三档让
 *  「明知故犯」变成一条**可检索的记录**，而不是一次沉默。 */
export const RT_DISPATCH = Object.freeze(['block', 'accept', 'advisory']);

/** 严重度。**只用于 `advisory` 的排序提示**，不参与阻断判定 ——
 *  阻断只看 `dispatch`。否则会出现「严重度高就能自动阻断」这种把权限偷换成
 *  严重度的写法，而严重度恰恰是红队自己的主观量。 */
export const RT_SEVERITY = Object.freeze(['high', 'medium', 'low']);

/** 最终裁决。`FAILED` 与 `BLOCKED` 分开：前者是「做过但错了」，
 *  后者是「没做完就发了」 —— 这两者的处置不同（前者修复后重验，后者补做）。 */
export const VERDICTS = Object.freeze(['PASS', 'FAILED', 'BLOCKED', 'UNKNOWN']);

/** 一条红队反例的**可判定形状**。
 *
 *  返回 `{problems: string[]}`，空数组 = 合法。名字逐条说明为什么不合格，
 *  而不是只说「格式不对」 —— 红队报告会被原样喂给下一个读者。
 *
 *  判据刻意严格在两个地方：
 *   1. `evidence` 必须是**可核查的锚点**（`file:line`、命令、或实测数字），
 *      不接受「见上文」「明显」。这与 `evidence-discipline.md` §1 同源。
 *   2. `dispatch` 必须是枚举值。**缺省不是 `advisory`** —— 缺省一旦可用，
 *      忘了写就等于「不阻断」，而那是静默的。 */
export function redteamItemProblems(item) {
  const problems = [];
  const it = item && typeof item === 'object' ? item : null;
  if (!it) return ['不是对象'];
  if (!it.id || !String(it.id).trim()) problems.push('缺 id（没有编号的反例无法被引用、也无法被判独立）');
  for (const k of ['trigger', 'failure']) {
    if (!it[k] || !String(it[k]).trim()) problems.push(`缺 ${k}`);
  }
  const sev = String(it.severity == null ? '' : it.severity).trim();
  if (!RT_SEVERITY.includes(sev)) {
    problems.push(`severity "${sev}" 不在 ${RT_SEVERITY.join(' / ')} 内`
      + '（严重度是红队自己的主观量，只能是这三档）');
  }
  const disp = String(it.dispatch == null ? '' : it.dispatch).trim();
  if (!RT_DISPATCH.includes(disp)) {
    // 缺省不许回落：`advisory` / `accept` 都会让交付继续，静默回落等于偷偷放行。
    problems.push(`dispatch "${disp}" 不在 ${RT_DISPATCH.join(' / ')} 内 —— `
      + '三档分别是「阻断」「记录风险」「明知故犯但留了记录」，缺省不是可选值');
  }
  if (disp === 'block' && !String(it.key_path || '').trim()) {
    // 「block」的合法性挂在一个**可判定**的字段上，不能挂在一句论证里。
    problems.push('dispatch=block 但没写 key_path —— 「关键路径」是阻断的必要条件，'
      + '不写就等于「我说它关键它就关键」');
  }
  if (disp === 'accept' && !String(it.accepted_by || '').trim()) {
    problems.push('dispatch=accept 但没写 accepted_by —— '
      + '风险接受必须有记录，否则它与「没人看见」不可区分');
  }
  const ev = String(it.evidence == null ? '' : it.evidence).trim();
  if (!ev) problems.push('缺 evidence');
  else if (!isAnchored(ev)) {
    problems.push(`evidence "${ev.slice(0, 40)}" 不像可核查的锚点`
      + '（应含 file:line / 命令 / 实测数字，见 evidence-discipline.md §1）');
  }
  return problems;
}

/** evidence 是否「像可核查的锚点」。
 *
 *  单独抽出来是因为它有两个调用方（红队条目、验收证据），而两处判据必须一致；
 *  各写一份的话，`file:1` 能过一处过不了另一处。
 *
 *  判据：含 `xxxx:NN`（file:line）、或含一段反引号命令、或含一个实测数字，
 *  或本身就是 http(s) 链接。**「见上文」这类不在其列** —— 它不可核查。
 *
 *  ## 数字那一条为什么不能带尾随 `\b`
 *
 *  `/\d+\s*(次|条|…)\b/` 看起来对，实际对中文一律不成立：JS 的 `\b` 基于 `\w`
 * （只有 ASCII 字母数字下划线），`次` 不是词字符，所以 `12 次` 与串尾之间
 * **没有**词边界 —— 一条正确的判据会静默把「实测 12 次」判成不可核查。
 * 实测踩过：`isAnchored('实测 12 次里 8 次复现')` 返回 false。
 * 所以数量判据分成两支：ASCII 单位用 `\b` 收尾，中文单位只在**前面**要求数字。 */
export function isAnchored(evidence) {
  const s = String(evidence == null ? '' : evidence).trim();
  if (!s) return false;
  if (/`[^`]+`/.test(s)) return true;                    // 内联命令 / 路径
  if (/\b\S+:\d+\b/.test(s)) return true;                // file:line
  if (/\d+(\.\d+)?\s*(%|条|个|次|行|字节|份|处|项|人)/.test(s)) return true;  // 中文量词
  if (/\d+(\.\d+)?\s*(ms|s|sec|MB|KB|GB|bytes?|px)\b/i.test(s)) return true;  // ASCII 单位
  if (/^\s*https?:\/\//.test(s)) return true;
  return false;
}

/** 覆盖声明是否满足 `evidence-discipline.md` §4 的四段。
 *
 *  只判**四段在不在**，不判写得对不对 —— 「写得对不对」不可机械判定，
 *  而「在不在」可以。这条刻意窄：一道判不了的规则不配进这道门，
 *  否则它又会退化成一句「请务必包含」。 */
export const COVERAGE_SECTIONS = Object.freeze([
  '我实际读了哪些文件',
  '我做了哪些检查',
  '我**没**做什么',
  '我无法核实的部分',
]);

export function coverageProblems(markdown) {
  const text = String(markdown == null ? '' : markdown);
  const problems = [];
  for (const sec of COVERAGE_SECTIONS) {
    if (!text.includes(sec)) problems.push(`缺「${sec}」一段`);
  }
  // 四段都在、全是空的也不行：那是「写了标题但没写内容」。
  // 判据是「段名之后、下一个段名之前至少有 1 个非空白字符」。
  for (const sec of COVERAGE_SECTIONS) {
    const at = text.indexOf(sec);
    if (at < 0) continue;
    const nextAt = COVERAGE_SECTIONS
      .map((s) => (s === sec ? -1 : text.indexOf(s, at + sec.length)))
      .filter((x) => x > at)
      .sort((a, b) => a - b)[0];
    const body = text.slice(at + sec.length, nextAt === undefined ? undefined : nextAt);
    if (!/\S/.test(body.replace(/[\s:：<>\-*`—]/g, ''))) {
      problems.push(`「${sec}」这一段是空的 —— 空段与没写同形`);
    }
  }
  return problems;
}

/** 验收结论的**唯一解析入口**：把 `acceptor` 的返回文本压成一个三元组。
 *
 *  `verdict` 只认三种写法（通过 / 不通过 / 未给出）——**不接受「基本通过」**。
 *  含糊的结论会被判 `UNKNOWN`，而 `UNKNOWN` 在裁决里不等于放行。
 *
 *  `items` 抽 `| AC1 | 通过/不通过 | 证据 | ... |` 这种表格行。抽不到不算错
 *  （有的验收用列表），但**「结论通过但没有逐项判定」要报问题** ——
 *  那正是「调用成功当成操作成功」的组织级版本：只给了整体印象，没给逐项证据。
 *
 *  ## 证据强度从哪里来
 *
 *  判定表里那一列证据是**人话**（`file:line`、命令输出），不是结构化数据。
 *  结构化证据来自 `evidence-json` 围栏块（可选）：
 *
 *  ```evidence-json
 *  [{ "id":"E1", "ac":"AC1", "key_path":"K1", "kind":"test",
 *     "command":"node --test scripts/", "producedBy":"acceptor" }]
 *  ```
 *
 *  没有这个块时 `evidenceItems` 是空的 → 关键路径上的强证据判据会**判不过**。
 *  这是刻意的：**默认判不过比默认判过安全**。验收要交付「可重放的强证据」
 *  这一条不能靠一句散文满足。
 *
 *  `key_path` 从判定表的**表头**定位，不按固定列序猜：
 *
 *      | # | 判定 | 证据 | 说明 | 关键路径 |
 *
 *  表头里出现「关键路径」的那一列就是它（没有这一列 = 没有 key_path）。
 *  固定列序（`cells[4]`）会静默读成「说明」列 —— 实测踩过：一份五列表
 *  `| AC1 | 通过 | a.mjs:12 | ok | K1 |` 会被读成 `key_path="ok"`，
 *  于是强证据挂在一条不存在的路径上，判据永远判不过，而屏幕上看不出原因。 */
export function parseAcceptorVerdict(markdown) {
  const text = String(markdown == null ? '' : markdown);
  const items = [];
  // 表头驱动：先找一张含「判定」与「证据」的表头，记下列号。
  let cols = null;
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const iVerdict = cells.findIndex((c) => /判定|结论/.test(c));
    const iEvidence = cells.findIndex((c) => /证据/.test(c));
    if (iVerdict > 0 && iEvidence > 0) {
      cols = {
        id: cells.findIndex((c) => /^#?$|编号|^\s*$/.test(c) || c === ''),
        verdict: iVerdict,
        evidence: iEvidence,
        keyPath: cells.findIndex((c) => /关键路径|key_path/.test(c)),
      };
      // 第一列是 id：表头最左通常写 `#`（会被 split 成空串）。
      if (cols.id < 0) cols.id = 1;
      if (cols.id === 0) cols.id = 1;
      break;
    }
  }
  const at = (cells, i) => (i >= 0 && i < cells.length ? cells[i] : '');
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    // 无表头时退回「第 2 列 id / 第 3 列判定 / 第 4 列证据」，且**不读 key_path**：
    // 列序未知时读到的第五列是「说明」，那是猜不是判。
    const id = cols ? at(cells, cols.id) : cells[1];
    const verdict = cols ? at(cells, cols.verdict) : cells[2];
    const evidence = cols ? at(cells, cols.evidence) : cells[3];
    if (!/^AC\d+/.test(id)) continue;
    if (!/通过|不通过|未通过|无法判定/.test(verdict)) continue;
    const kpRaw = cols && cols.keyPath > 0 ? at(cells, cols.keyPath) : '';
    items.push({
      id,
      pass: verdict === '通过',
      evidence,
      key_path: String(kpRaw).replace(/[*`]/g, '').trim() || null,
      evidenceItems: [],
    });
  }
  // 结构化证据：与判定项按 `ac` 关联，再把 `key_path` 回填到判定项上。
  const evBlock = /```evidence-json\s*\n([\s\S]*?)```/.exec(text);
  let evidenceItems = [];
  const problems = [];
  if (evBlock) {
    try {
      const parsed = JSON.parse(evBlock[1]);
      if (Array.isArray(parsed)) evidenceItems = parsed.filter((x) => x && typeof x === 'object');
      else problems.push('evidence-json 块不是数组 —— 它必须是证据项数组');
    } catch (e) {
      problems.push(`evidence-json 块不是合法 JSON：${e.message} —— 解析不了不能当成「没有结构化证据」`);
    }
  }
  for (const ev of evidenceItems) {
    const ac = String(ev.ac || '').trim();
    const kp = String(ev.key_path || '').trim();
    const target = items.find((x) => x.id === ac);
    if (target) {
      target.evidenceItems.push(ev);
      if (kp && !target.key_path) target.key_path = kp;
    }
  }
  let verdict = 'UNKNOWN';
  if (/##\s*验收结论[：:]\s*不通过/.test(text)) verdict = 'FAILED';
  else if (/##\s*验收结论[：:]\s*通过/.test(text)) verdict = 'PASS';

  if (verdict === 'UNKNOWN') {
    problems.push('读不出「## 验收结论：通过 / 不通过」—— 含糊的结论按 UNKNOWN 处理，不等于放行');
  }
  if (verdict === 'PASS') {
    if (!items.length) {
      problems.push('结论是通过，但一条逐项判定都没抽到 —— '
        + '「整体看起来不错」不是判定，逐项证据才是');
    }
    // 有「不通过」的条目却下「通过」的总论，是本仓最要防的自相矛盾形态。
    const failed = items.filter((x) => !x.pass);
    if (failed.length) {
      problems.push(`${failed.map((x) => x.id).join('、')} 判不通过，但总论写「通过」—— 两者必须一致`);
    }
  }
  // 证据为空 = 没证据。`evidence-discipline.md` §8：找不到证据即判不通过。
  for (const it of items) {
    if (it.pass && (!it.evidence || it.evidence === '—' || it.evidence === '-')) {
      problems.push(`${it.id} 判通过但证据列是空的 —— 「没找到反例」不等于「通过」`);
    }
  }
  return { verdict, items, problems };
}

/** 关键的「证据强度」判据：**弱证据不得替代强证据**。
 *
 *  `evidence-discipline.md` §2 的分层在这里落成数据。每个证据项的形状：
 *
 *      { id, kind, producedBy, replayable, location }
 *
 *  `kind` 的合法取值就是分层本身：
 *    · 强：`test`（可重放命令 + 真实输出）、`artifact`（磁盘文件）、
 *          `exit_code`（真实退出码）、`file_content`（磁盘文件内容）
 *    · 弱：`self_report`、`screenshot`、`log_paste`
 *
 *  ## 判据三条，都是可机械判定的
 *
 *  1. **`kind` 必须已知**。未知类型不许当强证据用（宁可判 `UNKNOWN`，不判 PASS）。
 *  2. **强证据必须带 `replayable` 的具体形态**：`test` 要含一条命令，
 *     `artifact` / `file_content` 要含一个路径 + 字节数，`exit_code` 要含数字。
 *     「我有测试」没有命令 = 弱证据，因为别人复现不了。
 *  3. **`producedBy` 不得与被验对象是同一个生成器**。这一条是「独立于生成者」的可判定形式：
 *     若 `producedBy` 与 `subject` 相等 → 判为**不能当强证据**。
 *
 *  返回逐项判定，`strong` 只有三项都过才为真。 */
export const EVIDENCE_KINDS = Object.freeze({
  // 强
  test: { strong: true, requires: 'command' },
  artifact: { strong: true, requires: 'path+bytes' },
  exit_code: { strong: true, requires: 'number' },
  file_content: { strong: true, requires: 'path+bytes' },
  // 弱
  self_report: { strong: false, requires: null },
  screenshot: { strong: false, requires: null },
  log_paste: { strong: false, requires: null },
});

export function classifyEvidence(item, { subject = null } = {}) {
  const it = item && typeof item === 'object' ? item : {};
  const kind = String(it.kind == null ? '' : it.kind).trim();
  const problems = [];
  const meta = EVIDENCE_KINDS[kind];
  if (!meta) {
    return { id: it.id || null, kind, strong: false, problems: [`未知的证据类型 "${kind}"`] };
  }
  let strong = meta.strong;
  if (meta.requires === 'command' && !String(it.command || '').trim()) {
    // 「我有测试」与「这是那条测试的命令」是两件事。前者无法被别人重放。
    problems.push('test 类证据必须写出可重放的命令（`command`）—— 没有命令的「跑过测试」是弱证据');
    strong = false;
  }
  if ((meta.requires === 'path+bytes') && !(String(it.path || '').trim() && Number(it.bytes) > 0)) {
    problems.push(`${kind} 类证据必须写出磁盘路径与真实字节数 —— 只说「生成了文件」无法核实`);
    strong = false;
  }
  if (meta.requires === 'number' && !Number.isFinite(Number(it.exitCode))) {
    problems.push('exit_code 类证据必须写出真实的 exitCode 数字');
    strong = false;
  }
  // 独立于生成者：这条不是格式，是「同一支笔不能既写答案又判对错」。
  if (strong && subject != null && it.producedBy != null && String(it.producedBy) === String(subject)) {
    problems.push(`producedBy 与被验对象都是 "${subject}" —— 自证不能当强证据（独立于生成者）`);
    strong = false;
  }
  return { id: it.id || null, kind, strong, problems };
}

/** 交付裁决函数。**唯一入口，纯函数。**
 *
 *  ## 输入
 *
 *  - `acceptor`：`parseAcceptorVerdict()` 的结果（或同形状对象）
 *  - `redteam`：`{ items: [...], coverage?: string }`
 *  - `criteria`：本次交付的**关键路径**声明（见下）
 *  - `deviationRefs`：`tasks/accepted-deviations.md` 里已登记的偏差编号
 *
 *  ## 「关键路径」的可判定定义
 *
 *  不是「很重要的功能」，而是**预先声明的一张路径清单**：
 *
 *      criteria.keyPaths = [{ id: 'K1', path: 'src/app/route.ts', why: '用户点到的那个按钮' }]
 *
 *  判据只有一条：**红队条目的 `key_path` 必须指向这张清单里的某个 `id`**。
 *  不在清单里的，一律按 `advisory` 处理（记录风险，不阻断）。
 *  这把「我说它关键它就关键」变成了「它必须在派发前被声明过」——
 *  与硬约束 4（标准必须预先声明）同一条结构。
 *
 *  ## 「替代」的可判定定义
 *
 *  `criteria.requiredStrong`：每条关键路径上**必须有**哪一类强证据。
 *  一个关键路径上的判定项，如果它的证据里一条 `strong` 都没有 → 判 `BLOCKED`，
 *  理由写「弱证据替代强证据」。这是「PASS 的必要条件」的唯一机械形式。
 *
 *  ## 裁决优先级（顺序固定，不是加权平均）
 *
 *  1. **红队阶段**：`dispatch=block` 且 `key_path` 在清单里 → `BLOCKED`
 *     （**先于验收**：验收 PASS 不能抵消它 —— 这正是「两件事都成立」的落点）
 *     红队条目本身不合法（缺 dispatch / 缺 evidence） → `BLOCKED`
 *     （一份判不了的红队报告不能当成「没有阻断项」，那是静默共识）
 *  2. **验收阶段**：结论不是 PASS → `FAILED`
 *     （`UNKNOWN` 单独一档 → `BLOCKED`：读不出结论与「判了不通过」处置不同）
 *  3. **强证据阶段**：关键路径上没有强证据 → `BLOCKED`（弱证据替代了强证据）
 *  4. 其余 → `PASS`（`advisory` 未登记台账时带 `riskUnlogged: true`）
 *
 *  为什么强证据排在验收**之后**：验收自己判了不通过时，下一步动作已经确定
 *  （修复后重验）；此时再报「缺强证据」只是噪音，而两者混成一个码会让
 *  「该补采样还是该修 bug」无从判断。反过来，验收 PASS 却只有弱证据 ——
 *  那正是伪完成，必须判 `BLOCKED` 而不是 `PASS`。
 *
 *  `BLOCKED` 与 `FAILED` 分开返回，是因为**处置不同**：前者要补采样/补强证据，
 *  后者要修复后重验。
 *
 *  `accept` 档的条目**不阻断**，但必须点名 `accepted_by`；没写就落到红队阶段的
 *  「不可判定」。
 *
 *  @returns {{verdict:string, blocking:object[], risky:object[], reasons:string[],
 *             phases:string[]}} `phases` 是「触发后回流到哪个 Phase」的机器可读形态。 */
export function deliverVerdict({
  acceptor = null,
  redteam = null,
  criteria = {},
  deviationRefs = [],
} = {}) {
  const blocking = [];
  const risky = [];
  const reasons = [];
  const phases = [];

  const keyPaths = Array.isArray(criteria.keyPaths) ? criteria.keyPaths : [];
  const keyPathIds = new Set(keyPaths.map((k) => String((k && k.id) || '').trim()).filter(Boolean));
  const items = Array.isArray(redteam && redteam.items) ? redteam.items : [];
  const acc = acceptor || { verdict: 'UNKNOWN', items: [], problems: [] };
  const devRefs = new Set((Array.isArray(deviationRefs) ? deviationRefs : []).map(String));

  const pushBlock = (code, detail, phase) => {
    blocking.push({ code, detail });
    reasons.push(`[${code}] ${detail}`);
    if (phase && !phases.includes(phase)) phases.push(phase);
  };

  // ── 1) 红队阻断项。**刻意排在验收之前**。
  //
  //  「验收 PASS 但红队阻断」是合法输入：验收判的是预声明标准（AC 逐条），
  //  红队找的是标准之外的东西。把它们加权求和，等于让「标准写得好不好」决定
  //  标准之外的风险能不能被看见 —— 那正是本文件要终结的「靠感觉选一个」。
  for (const raw of items) {
    const probs = redteamItemProblems(raw);
    if (probs.length) {
      pushBlock('redteam_malformed',
        `红队条目 ${String((raw && raw.id) || '(无编号)')} 不可判定：${probs.join('；')}`,
        'Phase B：红队重采样');
      continue;
    }
    const disp = String(raw.dispatch).trim();
    const kp = String(raw.key_path || '').trim();
    if (disp === 'block') {
      if (!keyPathIds.has(kp)) {
        // 不在清单里的「关键」不阻断 —— 但也不许静默降级成 advisory。
        // 它是「声明不足」，要么补进清单（派发前已声明才有意义），要么改判 advisory。
        pushBlock('key_path_undeclared',
          `红队条目 ${raw.id} 声称 key_path="${kp}"，但派发前的关键路径清单里没有这一项 —— `
          + '「关键」必须预先声明，事后声明与事后编造验收标准是同一类错',
          'Phase A：补声明关键路径（本轮不可事后补，须下一轮派发前声明）');
        continue;
      }
      pushBlock('redteam_block',
        `红队条目 ${raw.id} 判阻断：${raw.failure}（证据 ${raw.evidence}）`,
        'Phase E：先修复，再完整重新验收');
      continue;
    }
    if (disp === 'accept') {
      // 风险接受：可交付，但必须有记录。`redteamItemProblems` 已经保证 `accepted_by` 非空。
      risky.push({ id: raw.id, dispatch: disp, detail: `${raw.failure}（已由 ${raw.accepted_by} 接受）` });
      continue;
    }
    risky.push({ id: raw.id, dispatch: disp, detail: String(raw.failure || '') });
    if (!devRefs.has(String(raw.id))) {
      reasons.push(`[risk_unlogged] 红队条目 ${raw.id} 是 advisory，但没登记到偏差台账 —— `
        + '风险不阻断交付，但「记录在案」与「没人看见」必须分得开');
    }
  }

  // ── 2) 红队报告的整体完整性。
  //
  //  一份没有覆盖声明的红队报告，与「红队什么都没发现」在屏幕上同形 ——
  //  `evidence-discipline.md` §4 说「没有覆盖声明 = 报告不合格」，这里执行它。
  const rtCoverage = String((redteam && redteam.coverage) || '').trim();
  if (redteam && items.length === 0) {
    // 空反例清单是合法的，但它必须自带「我实际查了什么」—— 否则「没找到」
    // 无法与「没查」区分（`grader` 与 `checker` 的差别）。
    if (!rtCoverage) {
      pushBlock('redteam_no_coverage',
        '红队反例清单为空且没有覆盖声明 —— 无法区分「查了没有问题」与「没有查」',
        'Phase B：要求红队补覆盖声明（重采样）');
    } else {
      const cp = coverageProblems(rtCoverage);
      if (cp.length) {
        pushBlock('redteam_coverage_incomplete',
          `红队覆盖声明不完整：${cp.join('；')}`,
          'Phase B：要求红队补覆盖声明（重采样）');
      }
    }
  }

  // ── 2) 验收结论（排在强证据之前，理由见函数头「裁决优先级」）。
  if (acc.verdict !== 'PASS') {
    // `UNKNOWN`（读不出结论）与 `FAILED`（判了不通过）要分开：
    //   · FAILED  → 下一步是「修复后重验」，动作确定；
    //   · UNKNOWN → 下一步是「补一次能读出结论的验收」，动作是补采样。
    // 混成一个码，前面的红队结果再干净也无法告诉人该做什么。
    pushBlock(acc.verdict === 'UNKNOWN' ? 'accept_unknown' : 'accept_not_pass',
      `验收结论是 ${acc.verdict}，不是 PASS${Array.isArray(acc.problems) && acc.problems.length ? `：${acc.problems.join('；')}` : ''}`,
      acc.verdict === 'UNKNOWN' ? 'Phase E：补一次可读出结论的验收' : 'Phase E：修复后完整重新验收');
  }

  // ── 3) 关键路径上的强证据。
  //
  //  只在**验收已经 PASS** 之后才判：验收自己没过时，下一步动作已确定，
  //  再报「缺强证据」是噪音。而验收 PASS 却只有弱证据 —— 那正是伪完成。
  //
  //  `criteria.requiredStrong` 的形状：
  //    [{ key_path: 'K1', kinds: ['test','artifact'] }]
  //  含义：K1 这条路径上，**至少一条**判定项的证据必须是这些强类型之一。
  //
  //  为什么不是「每条判定项都要强证据」：判定项里天然有「不加依赖」这类纯判断，
  //  要求它有强证据会在合法的交付上造一条永久的红。
  const shouldCheckStrength = acc.verdict === 'PASS';
  const reqStrong = shouldCheckStrength && Array.isArray(criteria.requiredStrong)
    ? criteria.requiredStrong : [];
  for (const req of reqStrong) {
    const kp = String((req && req.key_path) || '').trim();
    if (!keyPathIds.has(kp)) {
      pushBlock('strong_req_undeclared',
        `requiredStrong 指向未声明的关键路径 "${kp}" —— 强证据要求必须挂在派发前声明的路径上`,
        'Phase A：补声明关键路径');
      continue;
    }
    const kinds = Array.isArray(req && req.kinds) && req.kinds.length ? req.kinds : [];
    const strongKinds = kinds.filter((k) => EVIDENCE_KINDS[k] && EVIDENCE_KINDS[k].strong);
    if (!strongKinds.length) {
      pushBlock('strong_req_weak',
        `关键路径 ${kp} 要求强证据，但 kinds 里一个强类型都没写（${kinds.join('/') || '空'}）—— `
        + `那等于用弱证据替代强证据；合法强类型：${Object.keys(EVIDENCE_KINDS).filter((k) => EVIDENCE_KINDS[k].strong).join('/')}`,
        'Phase A：修正强证据要求');
      continue;
    }
    const accItems = Array.isArray(acc.items) ? acc.items.filter((x) => x.key_path === kp) : [];
    const evs = accItems.flatMap((x) => (Array.isArray(x.evidenceItems) ? x.evidenceItems : []));
    const ok = evs.some((e) => {
      const r = classifyEvidence(e, { subject: criteria.subject || null });
      return r.strong && strongKinds.includes(r.kind);
    });
    if (!ok) {
      pushBlock('weak_replaces_strong',
        `关键路径 ${kp} 上没有一条强证据（要求 ${strongKinds.join('/')}）—— `
        + '「调用成功」被当成了「操作成功」正是这种形态',
        'Phase E：补一次可重放的强证据，再验收');
    }
  }

  // 验收结论已在第 2 段处理（`accept_not_pass` / `accept_unknown`）。
  // 这里**不再重复判**：重复一次会让「验收 FAILED」同时产出两个码，
  // 而 `onlyAcceptFail` 那条判据会因为多出一个码而永远判不出 `FAILED`。

  if (blocking.length) {
    // **`BLOCKED` 与 `FAILED` 必须分开。** 判据是「阻断项的性质」：
    //   · 只有 `accept_not_pass` → 验收真的判了不通过 → `FAILED`（修复后重验）；
    //   · 其余（红队阻断 / 声明缺失 / 弱证据替代强证据 / 读不出结论）→ `BLOCKED`。
    // 两者混成一个码，下一步动作就无从确定（补采样还是修 bug 是两件事）。
    const onlyAcceptFail = blocking.every((b) => b.code === 'accept_not_pass');
    return {
      verdict: onlyAcceptFail ? 'FAILED' : 'BLOCKED',
      blocking,
      risky,
      reasons,
      phases: phases.length ? phases : ['Phase E'],
    };
  }
  const unlogged = reasons.some((r) => r.startsWith('[risk_unlogged]'));
  return {
    verdict: 'PASS',
    blocking: [],
    risky,
    reasons,
    phases: [],
    riskUnlogged: unlogged,
  };
}

// ── 红队报告的读取（`redteam.md` 的唯一解析入口）───────────────────────
//
// ## 为什么这一段必须在同一个文件里
//
// `parseAcceptorVerdict()` 与 `parseRedteamReport()` 是同一件事的两半：
// 裁决函数的两个输入各有一个来源，而它们的**格式判据必须来自同一份规范**
// （`oversight-redteam.md` 的「反例列表」表 / `oversight-acceptor.md` 的「逐项判定」表）。
// 分成两个文件之后，改一个格式就会只改一处 —— 而那正是本仓「十种模板、零个解析器」
// 的老病：红队的列名换了，收活脚本读到空数组，然后「没有阻断项」与「没读到」同形。
//
// ## 表格判据是**表头驱动**的，不按固定列序猜
//
// 理由与 `parseAcceptorVerdict()` 的 `key_path` 一段逐字相同：按列号读会把
// 「说明」列读成 `key_path`，然后强证据挂在一条不存在的路径上，判据永远判不过，
// 而屏幕上只看得出「红队判了阻断」。表头里有哪一列，就读哪一列。

/** 红队反例表的列名 → 字段。**别名并列写**：红队是模型写的，列名会有措辞漂移，
 *  而「漂了就读不到」的后果是整份报告被判 malformed —— 那对一次真实交付是过重的惩罚。
 *  但**不猜语义**：只接受近义词，不接受「同义词表里没写的任何东西」。 */
const RT_COLUMNS = Object.freeze({
  id: /^#?$|^\s*$|编号|^id$/i,
  trigger: /触发|trigger/i,
  failure: /失败表现|后果|fail/i,
  severity: /严重|severity/i,
  dispatch: /dispatch|处置|裁决/i,
  key_path: /关键路径|key_path/i,
  evidence: /证据|evidence/i,
  accepted_by: /接受者|accepted_by|谁接受/i,
});

/** 从 `redteam.md` 抄出 `{items, coverage}`。
 *
 *  ## 三条判据，都是可机械判定的
 *
 *  1. **只认「反例列表」节里的表**。正文别处也可能有表格（例如三档权限的说明表），
 *     把它们当成反例会凭空造出阻断项。
 *  2. **`## 覆盖声明` 整节原样带回去**（`coverage`），因为 `deliverVerdict()` 要用它
 *     区分「查了没有问题」与「没有查」。
 *  3. **读不到表就返回空 items + `problems`**，不返回 null ——
 *     `null` 会让调用方误以为「这份报告不存在」，而「存在但读不出」是另一件事。
 *
 *  @returns {{items:object[], coverage:string, problems:string[]}}
 */
export function parseRedteamReport(markdown) {
  const text = String(markdown == null ? '' : markdown);
  const problems = [];

  // 覆盖声明：从 `## 覆盖声明` 到下一个 `## ` 为止。它可以是四段列表，也可以是一段散文。
  let coverage = '';
  const covAt = text.search(/^##\s*覆盖声明\s*$/m);
  if (covAt >= 0) {
    const rest = text.slice(covAt);
    const nextH2 = rest.slice(1).search(/^##\s/m);
    coverage = (nextH2 < 0 ? rest : rest.slice(0, nextH2 + 1)).trim();
  }

  // 反例列表节：`## 反例列表` 到下一个 `## ` 为止。
  const listAt = text.search(/^##\s*反例列表\s*$/m);
  if (listAt < 0) {
    problems.push('读不到「## 反例列表」一节 —— 红队报告的格式约定在 oversight-redteam.md，'
      + '改格式必须同时改这里，否则收活读到的是空清单（而空清单看起来像「没发现问题」）');
    return { items: [], coverage, problems };
  }
  const afterList = text.slice(listAt);
  const nextH2 = afterList.slice(1).search(/^##\s/m);
  const section = nextH2 < 0 ? afterList : afterList.slice(0, nextH2 + 1);

  // 表头驱动：先定位一张含 `dispatch` 与 `evidence` 的表头，记下列号。
  let cols = null;
  const lines = section.split('\n');
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const found = {};
    for (const [field, re] of Object.entries(RT_COLUMNS)) {
      const i = cells.findIndex((c, idx) => idx > 0 && re.test(c));
      if (i > 0) found[field] = i;
    }
    if (found.dispatch === undefined || found.evidence === undefined) continue;
    // `id` 的别名规则太宽（空串 / `#`），最后再兜一次：默认为第一列。
    if (found.id === undefined) found.id = 1;
    cols = found;
    break;
  }
  if (!cols) {
    problems.push('「## 反例列表」里有表格，但表头读不到 dispatch / evidence 两列 —— '
      + '表格形状变了，而按列号硬读会静默把「说明」读成证据');
    return { items: [], coverage, problems };
  }

  const items = [];
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length <= Math.max(cols.dispatch, cols.evidence)) continue;
    const id = cells[cols.id] || '';
    // 表头行与分隔行跳过：id 里不该出现 `-` 开头的分隔或「#」。
    if (!id || /^#+$/.test(id) || /^-+$/.test(id)) continue;
    const get = (k) => (cols[k] !== undefined && cells[cols[k]] !== undefined ? cells[cols[k]] : '');
    const item = {
      id,
      trigger: get('trigger'),
      failure: get('failure'),
      severity: get('severity'),
      dispatch: get('dispatch'),
      evidence: get('evidence'),
    };
    const kp = get('key_path');
    if (kp) item.key_path = kp;
    const acc = get('accepted_by');
    if (acc) item.accepted_by = acc;
    items.push(item);
  }
  if (!items.length) {
    // 空反例清单是**合法**的（真的没发现问题），所以这里不判 problem。
    // 但它必须配覆盖声明 —— 那条判据在 `deliverVerdict()` 里，不在这里重复。
  }
  return { items, coverage, problems };
}

// ── CLI：收活时打印裁决 ───────────────────────────────────────────────
//
// ## 它治的是什么（DF-080）
//
// 这个文件在 2026-11-22 有 39 条测试、零调用点。一个没有调用点的门与不存在同形
// （DF-042 的原始形态）。SKILL.md 的 Phase E 现在必须调用它，而**调用形态必须是一条
// 能贴进流程的命令** —— 「另行写个脚本读它」等于把接线又推给下一个人。
//
// 退出码是**判据的一部分**：
//   0 = PASS（可交付）
//   1 = FAILED（验收判了不通过，修复后重验）
//   2 = BLOCKED（红队阻断 / 读不出结论 / 弱证据替代强证据）
//   3 = 用法错误（缺参数、文件读不到、JSON 坏）
// 分开而不是「非零即失败」：FAILED 的下一步是修复，BLOCKED 的下一步是补采样/补强证据，
// 这两件事混成一个码，拿到裁决的人不知道该做什么。

const CLI_HELP = `delivery-verdict — 收活时对「这份交付能不能发」给出唯一裁决。

用法：
  node scripts/delivery-verdict.mjs --acceptor tasks/runs/<run-id>/acceptor.md
                                    --redteam  tasks/runs/<run-id>/redteam.md
                                    --key-paths <keypaths.json>
                                    [--required-strong <requirements.json>]
                                    [--subject <被验对象的名字>]
                                    [--deviation-refs <table.md>]
                                    [--json]

  --acceptor        验收报告（Markdown）。不传 = 没有验收结论 = BLOCKED（不是放行）。
  --redteam         红队报告（Markdown）。不传 = 红队缺席 = 没有覆盖声明，
                    **裁决会给 BLOCKED（exit 2）**，不是「没有阻断项」。
                    一份没有覆盖声明的红队报告无法区分「查了没有问题」与「没有查」。
  --key-paths       派发前声明的关键路径清单：[{"id":"K1","path":"src/app.ts","why":"..."}]
                    不传 = 没有任何路径被声明过，于是红队的 block 条目会在**派发阶段**
                    被判 key_path_undeclared（这不是 bug，是「关键必须预先声明」的落点）。
  --required-strong 强证据要求：[{"key_path":"K1","kinds":["test","artifact"]}]
  --subject         被验对象的名字。与证据的 producedBy 相同则判「自证不算强证据」。
  --deviation-refs  偏差台账（tasks/accepted-deviations.md）。advisory 条目未登记时给
                    riskUnlogged: true —— 不阻断，但「记录在案」与「没人看见」要分得开。
                    （登记格式按 DF-xxx / AD-yyy 编号，与红队条目的 id 对应）
  --json            机器可读输出（同一份数据）。

退出码：0 PASS / 1 FAILED / 2 BLOCKED / 3 用法错误。

**读不到 ≠ 通过。** 报告文件不存在时直接 exit 3，不回落成「空报告 → 没有阻断」。
`;

function readTextOrNull(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

/** `--deviation-refs` 读的是**台账文件**，要从中抽出已登记的编号。
 *
 *  为什么不在调用方现写一个数组：台账是给人写的 markdown，人不会维护第二份 JSON。
 *  抽出 `DF-xxx` / `AD-yyy` 两种编号（红队条目通常用 `RT1` 这类 id，
 *  但「登记到偏差台账」这件事的落点是台账自己的编号 —— 一个条目被接受时，
 *  红队会把它写成 `DF-082` 之类）。读不到就返回空集合，**不报错**：
 *  `riskUnlogged` 只会变得更保守（更多条目被标成未登记），不会更松。 */
export function deviationRefsFrom(text) {
  const out = new Set();
  for (const m of String(text == null ? '' : text).matchAll(/\b((?:DF|AD)-\d{3})\b/g)) out.add(m[1]);
  return [...out];
}

function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--json') { args.json = true; continue; }
    if (!a.startsWith('--')) return { error: `无法识别的参数：${a}` };
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val == null || val.startsWith('--')) return { error: `${a} 缺少取值` };
    args[key] = val;
    i++;
  }
  return args;
}

/** JSON 文件读取。**解析失败不回落成 `[]`** —— 回落等于「你给的 keyPaths 被静默丢掉」，
 *  于是全部红队 block 条目都会变成 key_path_undeclared，而屏幕上看起来像红队写错了。 */
function readJsonArg(path, label) {
  const text = readTextOrNull(path);
  if (text == null) return { error: `${label} 读不到：${path}` };
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { return { error: `${label} 不是合法 JSON：${e.message}` }; }
  if (!Array.isArray(parsed)) return { error: `${label} 必须是数组（它是一张清单，不是一个对象）` };
  return { value: parsed };
}

/** 主流程。**返回退出码，不调用 process.exit** —— 这样测试能直接调它，
 *  而 CLI 包装只在文件被直接执行时把返回值交给 process.exit。 */
export function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  if (args.error) { console.error(args.error); console.error(CLI_HELP); return 3; }
  if (args.help || !argv.length) { console.log(CLI_HELP); return args.help ? 0 : 3; }

  // ── 输入。**每一个缺失都是「读不到」，不是「空」** ──────────────────
  //
  //  这条与 `deliverVerdict()` 的缺省值不是一回事：函数层缺省 acceptor = UNKNOWN
  //  （BLOCKED），那是给**调用方已经决定不提供**的场景用的；CLI 层是「你说要给，
  //  但文件不在」—— 那必须立刻停下，而不是往下走。
  if (!args.acceptor) {
    console.error('缺 --acceptor：没有验收报告就没有验收结论，而缺席不是放行');
    return 3;
  }
  const accText = readTextOrNull(args.acceptor);
  if (accText == null) { console.error(`--acceptor 读不到：${args.acceptor}`); return 3; }

  let redteam = null;
  if (args.redteam) {
    const rtText = readTextOrNull(args.redteam);
    if (rtText == null) { console.error(`--redteam 读不到：${args.redteam}`); return 3; }
    const parsed = parseRedteamReport(rtText);
    // 解析问题**写进 coverage 之外单独带回去**：`deliverVerdict()` 不认识 problems，
    // 所以这里把「读不出表」折成一条 malformed 条目 —— 一份读不出的红队报告
    // 不能被当成「没有阻断项」，那是静默共识（契约 §8 的第 2 条同源）。
    for (const p of parsed.problems) {
      parsed.items.push({ id: '(unparsable)', dispatch: 'block', failure: p, severity: 'high', evidence: p });
    }
    redteam = { items: parsed.items, coverage: parsed.coverage };
  } else {
    // ## 不传 `--redteam` **不是**「红队没发现问题」
    //
    // 第一版这里留 `null`，于是 `deliverVerdict()` 里那句
    // `if (redteam && items.length === 0)` 短路 → 没有任何 redteam 判据生效 →
    // 裁决给 `PASS`。实测就是 `exit 0 / 无阻断项、无风险项`。
    // 而帮助文本写着「不传 = 红队缺席；**不是**「没有阻断项」」—— **文案与代码相反**，
    // 正是本仓反复批评的那种形态（说了却没人执行）。
    //
    // 正确的语义：红队缺席 = 没有覆盖声明 = 无法区分「查了没有问题」与「没有查」。
    // 所以这里显式造一份「空清单 + 无覆盖声明」的报告，让 `deliverVerdict()` 的
    // `redteam_no_coverage` 把它判成 `BLOCKED` —— 判据留在函数里，CLI 只负责
    // **不要用 null 把它短路掉**。判成 BLOCKED 而不是用法错误（exit 3），
    // 是因为它是一个**结论**（「这份交付现在不能发」），不是「你命令打错了」。
    redteam = { items: [], coverage: '' };
  }

  let keyPaths = [];
  if (args['key-paths']) {
    const r = readJsonArg(args['key-paths'], '--key-paths');
    if (r.error) { console.error(r.error); return 3; }
    keyPaths = r.value;
  }
  let requiredStrong = [];
  if (args['required-strong']) {
    const r = readJsonArg(args['required-strong'], '--required-strong');
    if (r.error) { console.error(r.error); return 3; }
    requiredStrong = r.value;
  }
  let deviationRefs = [];
  if (args['deviation-refs']) {
    const t = readTextOrNull(args['deviation-refs']);
    if (t == null) { console.error(`--deviation-refs 读不到：${args['deviation-refs']}`); return 3; }
    deviationRefs = deviationRefsFrom(t);
  }

  const acceptor = parseAcceptorVerdict(accText);
  const result = deliverVerdict({
    acceptor,
    redteam,
    criteria: { keyPaths, requiredStrong, subject: args.subject || null },
    deviationRefs,
  });

  if (args.json) {
    console.log(JSON.stringify({ ...result, acceptor: { verdict: acceptor.verdict, items: acceptor.items } }, null, 2));
  } else {
    console.log(`交付裁决：${result.verdict}`);
    if (acceptor.verdict !== result.verdict) console.log(`  验收结论：${acceptor.verdict}`);
    for (const b of result.blocking) console.log(`  [阻断 ${b.code}] ${b.detail}`);
    for (const r of result.risky) console.log(`  [风险 ${r.dispatch}] ${r.id}：${r.detail}`);
    for (const r of result.reasons.filter((x) => x.startsWith('[risk_unlogged]'))) console.log(`  ${r}`);
    for (const p of result.phases) console.log(`  回流：${p}`);
    if (result.verdict === 'PASS' && !result.risky.length && !result.reasons.length) {
      console.log('  无阻断项、无风险项。');
    }
  }
  if (result.verdict === 'FAILED') return 1;
  if (result.verdict === 'BLOCKED') return 2;
  return 0;
}

/** 「我是不是被直接执行」——比的是**真实路径**。`resolve()` 只规范化路径、不解析
 *  符号链接，而 `fileURLToPath(import.meta.url)` 已经是真实路径；通过目录符号链接执行
 *  （`npm link` / `npm i -g .` / pnpm 的 store）时两边必然不等，程序会静默 exit 0、零输出。
 *  realpath 失败（路径不存在）退回 resolve：一次失败不能让正常执行也坏掉。 */
const realOrResolve = (p) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};
if (process.argv[1] && realOrResolve(process.argv[1]) === realOrResolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
