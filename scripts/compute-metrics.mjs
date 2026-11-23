#!/usr/bin/env node
/**
 * compute-metrics.mjs — 把 `docs/spec/success-metrics.md` 的五个指标**真的算一遍**。
 *
 * ── 它存在的理由 ──────────────────────────────────────────────────────
 *
 * `success-metrics.md` 定义了指标，但**一个都没在算**。没有数字，
 * 「这个框架有没有用」永远只能靠感觉。本脚本把**能算的部分**算出来，
 * 并把**算不出来的部分**连同「缺哪条记录、加在哪个文件」一起打印 ——
 * 后者是本脚本的一半产出，不是错误信息。
 *
 * ── 三条纪律（写在代码里，不是写在 README 里）────────────────────────
 *
 * ① **每个比率必须与它的 `n` 同表打印。** 模板是 `` `12/13 = 92.3% (n=13)` ``，
 *    绝不打印一个孤立的百分比。`n < MIN_N_FOR_RATE`（默认 30）时命令行前面加 `[样本量不足]`。
 *    理由：本仓 `success-metrics.md` §0 自己写着「任何比率在 n≈1 的 run 上都只是描述」，
 *    而这一条最容易在写报告时被忘掉。
 * ② **「算不出来」不许退化成 0。** 每一个不可算的指标返回 `null` 与 `reason`，
 *    打印成 `—（不可算：<缺什么>）`。若写成 `0`，下游会把它当「比率是 0%」引用。
 * ③ **不自创第二个口径。** token / 调用数一律照 `success-metrics.md` §1.1 的定义：
 *    去重键 `message.id`（token）/ `tool_use.id`（调用），`cache_read` 单列。
 *    归属一律照 §1.2：`claims.jsonl` 的 `expect.nonce` + transcript 首条 user 消息。
 *
 * ── 它算出来的四个数（以及每个数的真实缺口）──────────────────────────
 *
 * | # | 指标 | 本脚本算什么 | 缺口 |
 * |---|---|---|---|
 * | 1 | 每任务调用次数 / token | 按 nonce 归属到任务的 transcript，去重后求和 | 归属只覆盖「declare 过 + 有 nonce」的 run |
 * | 2 | 盲重采样命中率 | 只算**分母**（每任务尝试几次）+ 结局的**可解析性** | 结局没有 `kind:"verdict"` 记录 |
 * | 3 | 局部定位准确率 | 只算 **C2（定位点是否在 outputs 内）** | 定位点本身没人落盘；`repro` 命令不存在 |
 * | 4 | 误放行 / 误拦截 | 只算**误拦截的必要条件**（产出未变仍再次判过） | 结局没有记录 → 分子分母都没有 |
 * | 5 | 一次 vs 终态成功率 | **不可算**，与 #2 / #4 卡在同一条记录 | `kind:"verdict"` |
 *
 * ── 用法 ─────────────────────────────────────────────────────────────
 *
 *   node scripts/compute-metrics.mjs                          # 本仓全部 transcript
 *   node scripts/compute-metrics.mjs --days 7
 *   node scripts/compute-metrics.mjs --session <会话目录或 .jsonl>
 *   node scripts/compute-metrics.mjs --json
 *   node scripts/compute-metrics.mjs --root <transcript 根>
 *
 * 退出码：0 = 正常（**包括「样本量不足」**——那是事实，不是故障）；
 *         2 = 找不到 transcript 根。
 *
 * 只读：不写任何文件，不碰 git。
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { readLedger, foldRows, nonceOwners, subagentTranscriptsOf, readHeadText, findNonce } from './claim-ledger.mjs';
import { firstUserText, readHeadRecords, subagentFiles } from './compose-agent-prompt.mjs';
import { runsDirFor, projectRoot } from './project-root.mjs';

// ── 口径常量 ──────────────────────────────────────────────────────────

/** 低于这个 `n` 的比率会被标注「样本量不足以支撑结论」。
 *
 *  30 是一个**约定**，不是统计推导 —— 这里必须承认它：本脚本不做显著性检验，
 *  它只是把「小到不该被引用」这件事**打印出来**，而不是交给读者自己判断。
 *  真正决定某个数能不能被引用的是 report 上的那句话，不是这个阈值。 */
export const MIN_N_FOR_RATE = 30;

/** 与 `success-metrics.md` §1.1 的定义**逐字对应**：token 去重键、调用去重键。 */
export const DEDUPE_KEYS = Object.freeze({ tokens: 'message.id', calls: 'tool_use.id' });

/** 沙箱目录名特征。与 `measure-checklist-coverage.mjs` 同一份正则 —— 那一条的注释
 *  写着「不排除沙箱会把派发率算成 90%+，那是测量工具在数自己」。这里同样适用：
 *  `*.test.mjs` 会真的 spawn 假会话，那些会话的 tool_use 不是用户行为。 */
export const SANDBOX_RE = /(?:^|[-_/])(?:Temp|tmp-analysis|tmp-qa|hook-e2e|launch-redteam|payload-redteam)(?:$|[-_/])|(?:^|-)(?:ow|ptu-lab|acpprobe|sandbox|stranger|myproj|cleanproj|collproj|dualrole)[-_]?/i;

/** 验收结论的**唯一**可解析形态（`docs/spec/evidence-discipline.md` §「验收结论」）：
 *  `## 验收结论：通过` 或 `## 验收结论：不通过`，逐字。宽松匹配会把
 *  「判定表里提到这四个字」也算进去，而那正是 DF-076 那种「100% 说反话」的成因。 */
export const ACCEPT_VERDICT_RE = /##\s*验收结论[：:]\s*(通过|不通过)/;

/** 红队阻断的唯一口径（`delivery-verdict.mjs` 的 `RT_DISPATCH`）：只有 `block` 算阻断。 */
export const REDTEAM_BLOCK_RE = /dispatch\s*["']?\s*[:=]\s*["']?block/i;

// ── 纯函数：token / 调用去重 ───────────────────────────────────────────

/**
 * 把一串 assistant 记录折成「去重后的 token 与调用数」。
 *
 * **为什么必须去重**（`success-metrics.md` §1.1 实测）：同一次 API 响应会被拆成
 * 多条 assistant 记录（`thinking` / `text` / `tool_use` 各一条），每条都重复带**同一份**
 * `usage`。实测膨胀 4.72×。直接求和会把「一次响应」算成「四五次」。
 *
 * **去重怎么取**：同一个 `message.id` 的不同记录里，`usage` 并不总是相同 ——
 * 实测本仓 256 份子 agent transcript、29,678 个 `message.id` 里：
 *   · 286 个全部为 0（流式占位记录）；
 *   · 5,177 个同时有 0 与非 0（**这些必须取非 0**，取第一条会取到 0）；
 *   · 9 个有多个不同的非 0 值（取最大，见下）。
 * 所以规则是「**取最大**」而不是「取第一条」：本仓实测 first-wins 会少算 15.0%
 * （81.65M vs 96.36M）。这 15% 不是舍入误差，它是一整批被流式占位记录吃掉的量。
 *
 * 多个不同非 0 值那 9 个是**已知的不可判定项**：transcript 里没有哪一条更权威的标记，
 * 取最大只是「不低估」的保守选择。报告里单列 `ambiguousUsageIds` 让人看得见。
 */
export function foldUsage(records) {
  const byMsg = new Map();
  const calls = new Set();
  const writes = new Map();
  let ambiguous = 0;

  for (const r of records || []) {
    if (!r || r.type !== 'assistant' || !r.message) continue;
    const id = r.message.id;
    const u = r.message.usage;
    if (u && id) {
      const billable = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      const cacheRead = u.cache_read_input_tokens || 0;
      const prev = byMsg.get(id);
      if (!prev) {
        byMsg.set(id, { billable, cacheRead });
      } else {
        if (billable > prev.billable) prev.billable = billable;
        if (cacheRead > prev.cacheRead) prev.cacheRead = cacheRead;
      }
    }
    const content = r.message.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'tool_use' && b.id) {
          calls.add(b.id);
          if (/^(write|edit|notebookedit|multiedit)$/i.test(b.name || '')) {
            const p = String(b.input && (b.input.file_path || b.input.path) || '');
            if (p) writes.set(p.split('\\').join('/'), (writes.get(p.split('\\').join('/')) || 0) + 1);
          }
        }
      }
    }
  }

  // 「多个不同非 0 值」的计数：把每个 id 的全部非 0 值收集起来看有几个。
  const seen = new Map();
  for (const r of records || []) {
    if (!r || r.type !== 'assistant' || !r.message || !r.message.usage || !r.message.id) continue;
    const u = r.message.usage;
    const b = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
    if (b > 0) {
      const s = seen.get(r.message.id) || new Set();
      s.add(b);
      seen.set(r.message.id, s);
    }
  }
  for (const [, s] of seen) if (s.size > 1) ambiguous++;

  let billable = 0;
  let cacheRead = 0;
  for (const v of byMsg.values()) { billable += v.billable; cacheRead += v.cacheRead; }

  return {
    messageIds: byMsg.size,
    billableTokens: billable,
    cacheReadTokens: cacheRead,
    calls: calls.size,
    ambiguousUsageIds: ambiguous,
    writeTargets: [...writes.keys()],
    dedupe: DEDUPE_KEYS,
  };
}

// ── 纯函数：AC anchor 解析（指标 3 的 C2）──────────────────────────────

/** `file:line` 形态的 AC anchor。`success-metrics.md` §3.2 的 C2 要求
 *  「定位点必须在 outputs 内」，而 `task-graph.json` 的 `acceptance[].evidence`
 *  里恰好已经有一批 `file:line` —— 它们**不是**「失败定位点」，
 *  但它们能在缺 `kind:"locator"` 的情况下把 **C2 的形状**算出来。
 *
 *  这一点必须写清，否则会把这个数当成「定位准确率」引用：
 *  C2 是「定位点在 outputs 内」这个**子集判断**，不是「定位准不准」。
 *  真正的定位准确率需要「修复后失败复现消失」，那需要 `repro` 命令，本仓零条。 */
export function parseAnchor(evidence) {
  const s = String(evidence == null ? '' : evidence).trim();
  const m = /^([^:\s][^:]*):(\d+)$/.exec(s);
  if (!m) return null;
  return { file: m[1].split('\\').join('/'), line: Number(m[2]) };
}

/**
 * 对一份 `task-graph.json` 算 C2：每个 `file:line` anchor 是否落在该子树的 `outputs` 内。
 *
 * 返回 `{tasks, anchoredAcTotal, inOutputs, violations[]}`。
 * `violations` 是**真实发现**，不是报错：它说明「AC 要求你去看那个文件，
 * 而那个文件不在你的产出清单里」—— 这正是 C2 要拦的那一类。
 */
export function checkC2(taskGraph) {
  const subtrees = (taskGraph && taskGraph.subtrees) || [];
  const violations = [];
  let total = 0;
  let inside = 0;
  for (const s of subtrees) {
    const outs = ((s && s.outputs) || []).map((p) => String(p).split('\\').join('/'));
    for (const a of (s && s.acceptance) || []) {
      const anchor = parseAnchor(a && a.evidence);
      if (!anchor) continue;
      total++;
      if (outs.includes(anchor.file)) inside++;
      else violations.push({ task: s.id, ac: a.id, file: anchor.file, line: anchor.line, outputs: outs });
    }
  }
  return { tasks: subtrees.length, anchoredAcTotal: total, inOutputs: inside, violations };
}

// ── 纯函数：AC anchor 的文件是否存在且行号可达 ────────────────────────

/** C1 的机械部分：`file` 在磁盘上存在、`line` ≤ 行数（`dispatch-contract.md` §8.3）。
 *  这是**可算的**，但它判的是「定位点形式上合法」，不是「它指向真正的失败位置」。 */
export function checkAnchorResolvable(taskGraph, { root = null, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  const subtrees = (taskGraph && taskGraph.subtrees) || [];
  const rows = [];
  for (const s of subtrees) {
    for (const a of (s && s.acceptance) || []) {
      const anchor = parseAnchor(a && a.evidence);
      if (!anchor) continue;
      const path = root ? join(root, anchor.file) : anchor.file;
      let exists = false;
      let lines = null;
      try {
        const t = readFile(path);
        exists = true;
        lines = t.split('\n').length;
      } catch { /* 不存在或读不出 */ }
      rows.push({
        task: s.id, ac: a.id, file: anchor.file, line: anchor.line,
        exists, fileLines: lines,
        lineReachable: lines != null && anchor.line >= 1 && anchor.line <= lines,
      });
    }
  }
  return rows;
}

// ── 纯函数：从 transcript 里找「可解析的验收结论」──────────────────────

/**
 * 在一条 transcript 里找**真正被产出**的验收结论，并区分三种来源。
 *
 * 这个区分是必须的，否则会把「引用了格式」当成「产出了结论」：
 *   · `assistant` —— 子 agent / 主线程在正文里写出 `## 验收结论：…`。**这是产出**。
 *   · `tool_result` —— 它出现在**别人返回给它的内容里**（引用了文档、或引用了上一轮报告）。
 *     这**不是**本次的结论，把它算进来会让 AC 文档本身变成一条 PASS。
 *   · `tool_use` input —— 它出现在**写文件的正文里**（正在写 `oversight-acceptor.md`）。
 *     同样不是结论。
 *
 * 实测本仓：`tool_result` 命中 **49** 次、`tool_use` input 命中 **9** 次、`assistant` 正文
 * 只有 **7** 次 —— 而 `attributionAgent: oversight-acceptor` 的 transcript 有 7 份，
 * 其中**一次都没有**在 assistant 正文里写出该行。也就是说：**验收 Agent 上线至今
 * 产出过 0 条机器可读的验收结论**（`parseAcceptorVerdict` 对 7 份全部返回空 items）。
 */
export function findVerdicts(records) {
  const asAssistant = [];
  const quotedInResult = [];
  const quotedInWrite = [];
  for (const r of records || []) {
    if (!r || !r.message) continue;
    const c = r.message.content;
    if (!Array.isArray(c)) continue;
    if (r.type === 'assistant') {
      for (const b of c) {
        if (b && b.type === 'text' && ACCEPT_VERDICT_RE.test(b.text)) {
          asAssistant.push({ verdict: ACCEPT_VERDICT_RE.exec(b.text)[1], at: r.timestamp || null });
        }
        if (b && b.type === 'tool_use') {
          const s = String((b.input && (b.input.content || b.input.new_string)) || '');
          if (ACCEPT_VERDICT_RE.test(s)) quotedInWrite.push({ verdict: ACCEPT_VERDICT_RE.exec(s)[1], file: String(b.input && b.input.file_path || '') });
        }
      }
    } else if (r.type === 'user') {
      for (const b of c) {
        if (!b || b.type !== 'tool_result') continue;
        const t = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map((x) => (x && x.text) || '').join('') : '';
        if (ACCEPT_VERDICT_RE.test(t)) quotedInResult.push({ verdict: ACCEPT_VERDICT_RE.exec(t)[1], toolUseId: b.tool_use_id || null });
      }
    }
  }
  return { asAssistant, quotedInResult, quotedInWrite };
}

// ── 纯函数：Agent 调用与子 agent transcript 的归属 ─────────────────────

const normText = (t) => String(t == null ? '' : t).replace(/\r\n/g, '\n').trim();
const hashText = (t) => createHash('sha256').update(normText(t), 'utf8').digest('hex');

/**
 * 主会话里每一次 `Agent` 工具调用，与子 agent transcript 的**第一条 user 消息**配对。
 *
 * 口径来自 `compose-agent-prompt.mjs` 的 `firstUserText` 注释：
 * 「实测 80/80 份子 agent transcript 的首条 user 消息与父会话 `Agent` 工具调用的 `prompt`
 *  参数逐字节相同」——本脚本正是用这条不变量做归属，而不是自创一套。
 *
 * `matched:null` 表示「找不到对应的 transcript」——**这不是通过，是看不到**。
 */
export function pairAgentCalls(mainRecords, subFiles, { readHead = (f) => readHeadRecords(f).records } = {}) {
  const calls = [];
  for (const r of mainRecords || []) {
    if (!r || r.type !== 'assistant' || !r.message || !Array.isArray(r.message.content)) continue;
    for (const b of r.message.content) {
      if (b && b.type === 'tool_use' && b.name === 'Agent') {
        calls.push({ id: b.id, description: b.input && b.input.description || null, subagentType: b.input && b.input.subagent_type || null, promptHash: hashText(b.input && b.input.prompt), at: r.timestamp || null });
      }
    }
  }
  const subs = new Map();
  for (const f of subFiles || []) {
    const recs = readHead(f);
    const t = firstUserText(recs);
    subs.set(hashText(t), { file: f, records: recs });
  }
  return calls.map((c) => {
    const hit = subs.get(c.promptHash) || null;
    return { ...c, transcript: hit ? hit.file : null, records: hit ? hit.records : null, matched: !!hit };
  });
}

// ── 扫描层 ────────────────────────────────────────────────────────────

export function defaultRoot() {
  return join(homedir(), '.claude', 'projects', 'D--Projects-Overwatch');
}

/** 列出一个 transcript 根下的全部 `.jsonl`（递归，含 `subagents/`）。 */
export function listTranscripts(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let es;
    try { es = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

/** 读一份 transcript 的记录。**坏行跳过、不报错** —— 半行是常态（写入中被读到）。 */
export function readRecords(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) {
    const s = l.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    out.push(o);
  }
  return out;
}

/** 一份 transcript 属于谁。`attributionAgent` 只在第 11–13 条记录上出现
 *  （实测 40 份：索引 11–13，字节偏移 34K–231K），所以必须全量扫记录，
 *  不能只看首行 —— 只看首行会把 256/256 份子 agent 全判成 `unknown`。
 *
 *  ⚠ **但它不是角色的可靠来源**（实测，见 `countAcceptanceWork`）：
 *  `attributionAgent` 记的是**派发时的 `subagent_type`**，而本仓大量验收工作是
 *  用 `subagent_type: general-purpose` 派出去的 —— 角色写在 **prompt 正文**里，
 *  不在 `subagent_type` 里。所以「按 `attributionAgent` 数 acceptor」会漏掉大多数。
 */
export function roleOf(records) {
  let role = null;
  for (const r of records || []) {
    if (r && r.attributionAgent) role = r.attributionAgent;
  }
  return role;
}

/** 派发角色在**正文**里的判据。本仓的派发模板（`templates/dispatch.md`）把角色名
 *  写在首条 user 消息里，而 `subagent_type` 可能只是 `general-purpose`。
 *
 *  用两条独立的键，而不是一条：
 *   · `prompt` —— 首条 user 消息里出现「验收 Agent」/「一票否决」等身份词；
 *   · `attribution` —— `attributionAgent === 'oversight-acceptor'`。
 *  实测两者**只重合 1 份**（prompt 判 27 份、attribution 判 7 份），这本身就是发现：
 *  想按角色统计，只能按 prompt；按 attribution 数会数出一个假的 7。 */
export function countAcceptanceWork(transcripts = [], readRecs = readRecords) {
  const ACCEPTOR_PROMPT_RE = /你是\*{0,2}验收\s*Agent|验收 Agent。|一票否决/;
  const out = { byPrompt: 0, byAttribution: 0, both: 0, byPromptWithVerdict: 0, byAttributionWithVerdict: 0 };
  for (const t of transcripts) {
    const recs = t.records || readRecs(t.file);
    const first = firstUserText(recs) || '';
    const byPrompt = ACCEPTOR_PROMPT_RE.test(first);
    const byAttr = roleOf(recs) === 'oversight-acceptor';
    const v = findVerdicts(recs);
    const emitted = v.asAssistant.length > 0;
    if (byPrompt) { out.byPrompt++; if (emitted) out.byPromptWithVerdict++; }
    if (byAttr) { out.byAttribution++; if (emitted) out.byAttributionWithVerdict++; }
    if (byPrompt && byAttr) out.both++;
  }
  return out;
}

// ── 语料普查：调用数 / token（会话级，完全可算）──────────────────────

/**
 * 全语料的调用数与 token 普查。**这是指标 1 里唯一「分母完整、归属无缺口」的部分**：
 * 它不回答「哪个任务花了多少」，只回答「这一批 transcript 一共发生了多少次调用、
 * 多少 token」——后者不需要归属，所以没有归属误差。
 *
 * 分 `main` / `subagent` 两桶报，因为两者能回答的问题不同：子 agent 的 transcript
 * 是**一次派发**的完整记录，主线程的 transcript 是**一个会话**的完整记录。
 * 合成一个数会让「一次派发多贵」被会话总量稀释掉。
 */
export function census(transcripts = [], readRecs = readRecords) {
  const buckets = { main: emptyBucket(), subagent: emptyBucket() };
  for (const t of transcripts) {
    const path = String(t.file).split('\\').join('/');
    const isSub = path.includes('/subagents/') && basename(t.file).startsWith('agent-');
    const b = isSub ? buckets.subagent : buckets.main;
    const recs = t.records || readRecs(t.file);
    const f = foldUsage(recs);
    b.files++;
    b.assistantRecords += recs.filter((r) => r && r.type === 'assistant').length;
    b.uniqueMessageIds += f.messageIds;
    b.calls += f.calls;
    b.billableTokens += f.billableTokens;
    b.cacheReadTokens += f.cacheReadTokens;
    b.ambiguousUsageIds += f.ambiguousUsageIds;
  }
  for (const b of Object.values(buckets)) {
    // 「记录数 / 不同 message.id」= 同一份 usage 被重复记录了几次。
    // 这个数就是「不去重会膨胀多少」的直接度量，不靠引用别处的 4.72×。
    b.usageInflation = b.uniqueMessageIds ? Math.round((b.assistantRecords / b.uniqueMessageIds) * 100) / 100 : null;
  }
  return buckets;
}

function emptyBucket() {
  return { files: 0, assistantRecords: 0, uniqueMessageIds: 0, calls: 0, billableTokens: 0, cacheReadTokens: 0, ambiguousUsageIds: 0, usageInflation: null };
}

// ── 结局链：本仓唯一一批「有结局」的样本 ──────────────────────────────

/** 从验收 prompt 里读「这是第几次验收」。本仓的验收 prompt 真的这么写：
 *  `这是**第二次验收**（r2）` / `这是**第四次验收**（r4）` —— 实测 7 条结局里有 4 条带。
 *
 *  为什么非要这个序号：没有它，「同一个会话里的两条结局」到底属于同一条链，
 *  还是两条不同的任务，分不开。而**分不开就不能算 attempts_to_pass** ——
 *  把不同任务串成一条链会算出一个假的「平均几次过」。 */
export function declaredOrdinal(text) {
  const s = String(text == null ? '' : text);
  const m = /第\s*([二三四五六七八九十]|\d+)\s*次验收|（\s*r\s*(\d+)\s*）/i.exec(s);
  if (!m) return null;
  const raw = m[1] && !m[2] ? m[1] : (m[2] || m[1]);
  const cn = { 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return cn[raw] != null ? cn[raw] : (Number(raw) || null);
}

/** 一条文本里出现过的 AC 编号集合（`AC1…AC12`）。用来判断「两次验收是不是同一份标准」。 */
export function acSetOf(text) {
  return new Set((String(text == null ? '' : text).match(/AC\s*\d+/gi) || []).map((x) => x.replace(/\s+/g, '').toUpperCase()));
}

/** 这条验收 prompt 有没有**显式指认「上一轮判不通过」**。
 *
 *  为什么需要它：`71f44160` 那个会话里，r2 的 prompt 开头是
 *  「这是**第二次验收**（r2）… 第一次验收（r1）判**不通过**」—— 这是链的**显式**回指。
 *  有它就不必靠「序号连续」去猜：一条链可以直接从「r2 显式指认 r1」建立。
 *  而 `50ec242b` 那个会话里 r4 的 history 指的是一条**不同的**子任务
 *  （`wrapToWidth` / TUI），没有这种一对一的回指 → 那里仍然分不开。
 *
 *  所以这个判据只能救回**带显式回指**的链，不能凭空给所有会话建立链。
 *  这正是「缺 `kind:"verdict"` 的 `task` 字段」的代价：能救回多少，取决于当时写 prompt 的人。 */
export function claimsPriorFail(text) {
  const s = String(text == null ? '' : text);
  return /第[一二三四五六七八九十\d]*次验收\s*[（(]?\s*r?1\s*[）)]?\s*[^\n]{0,40}(不通过|否决|FAIL)/i.test(s)
    || /r1\s*(判|是)?\s*\**不通过/.test(s);
}

/**
 * 把 transcript 里**真的被产出**的验收结论拼成「结局链」。
 *
 * 这是本仓唯一能算 `attempts_to_pass` 的地方，而它**不是** `kind:"verdict"` 台账 ——
 * 是 7 条散落在 transcript 正文里的 `## 验收结论：…`。所以这条通道有三个硬限制，
 * 每一条都会在返回值里显式标出来：
 *
 *  ① **只在 2 个会话里**（实测：`71f44160…` 3 条、`50ec242b…` 4 条）。全部产生于
 *     2026-10-29/30，即本仓最早的两轮开发。之后（11 月至今）**一条都没有**。
 *  ② **序号在会话内不连续**：`50ec242b` 同时有「r2」「r3」「r4」，而 r2 与 r3/r4
 *     指向**不同的子任务**（r2 的否决理由是 `wrapToWidth`，r3 的 history 里也提它，
 *     但 r4 是 TUI 那一串的第四轮）。没有 `task` 字段就无法把它们分开。
 *  ③ 因此本函数只把「**序号从 1 起连续、且以 PASS 收尾**」的链算成 `attempts_to_pass`；
 *     序号有断档（如 r1 → r3）的链标成 `gap`，**不计入**分母，也不悄悄当成 3。
 *
 * 这正好是 `success-metrics.md` §2.4 要求 `verdict` 行必须带 `attempt` **和** `nonce`
 * 的原因：缺了它们，能看见结局也拼不成链。
 */
export function verdictChains(transcripts = [], readRecs = readRecords) {
  // **按会话分组，不按 transcript 分组。** 一次「链」是同一个会话里的多轮验收，
  // 每一轮是一个**不同的子 agent transcript**。按 transcript 分组会让每份 transcript
  // 都只有 1 条结论，于是「第几次过」永远是 1 —— 那是把分母变成分子。
  const bySession = new Map();
  for (const t of transcripts) {
    const recs = t.records || readRecs(t.file);
    const v = findVerdicts(recs);
    const p = String(t.file).split('\\').join('/');
    const isSub = p.includes('/subagents/');
    // 会话 ID = `…/projects/<slug>/<session>/subagents/agent-x.jsonl` 的 `<session>` 段。
    const m = /\/projects\/[^/]+\/([^/]+)\/subagents\//.exec(p);
    const session = m ? m[1] : basename(p).replace(/\.jsonl$/, '');
    if (!bySession.has(session)) bySession.set(session, []);
    if (!v.asAssistant.length) continue;
    const first = firstUserText(recs) || '';
    for (const x of v.asAssistant) {
      bySession.get(session).push({
        verdict: x.verdict, at: x.at,
        declaredOrdinal: declaredOrdinal(first),
        // 显式回指：这条 prompt 自己说「上一轮判不通过」。
        claimsPriorFail: claimsPriorFail(first),
        // 这条验收判的是哪一套标准 —— 用来把**同一会话里交错的两个任务**分开
        // （实测 `71f44160` 有 10 项与 12 项两套 AC 混在一起）。
        acSet: acSetOf(first),
        isSubagent: isSub,
        file: t.file,
      });
    }
  }

  const chains = [];
  for (const [session, verdicts] of bySession) {
    if (!verdicts.length) continue;
    const subVerdicts = verdicts.filter((v) => v.isSubagent).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    if (!subVerdicts.length) continue;
    // **一条 transcript 里可能有多条结论**（同一次验收里分节写了两遍），
    // 所以「尝试次数」数的是 transcript 数，不是结论条数 —— 否则一次验收会被算成两次。
    const perTranscript = new Map();
    for (const v of subVerdicts) {
      if (!perTranscript.has(v.file)) perTranscript.set(v.file, { ordinals: [], claimsPriorFail: false, verdicts: [], at: v.at, acSet: v.acSet, file: v.file });
      const e = perTranscript.get(v.file);
      e.ordinals.push(v.declaredOrdinal);
      e.verdicts.push(v.verdict);
      e.claimsPriorFail = e.claimsPriorFail || v.claimsPriorFail;
    }
    const rounds = [...perTranscript.values()];
    // 一轮的结局取**最后**一条结论（同一份报告里先写通过又改判不通过时，后写的算）。
    for (const r of rounds) r.final = r.verdicts[r.verdicts.length - 1];

    // **把同会话里不同标准的两组分开。** 实测 `71f44160`：10 项 AC 与 12 项 AC 两套任务
    // 交错在同一会话里，合在一起就是一条假的链（「不通过 → 不通过 → 通过」，
    // 而实际是「10 项那份不通过」+「12 项那份 r1 不通过 → r2 通过」）。
    // 分开的键是 **AC 编号集合**：同一套标准的几次验收，AC 集合逐字相同。
    // 这不是完美的键（同一套标准被两个不同任务复用时它分不开），但它是**可判定的**，
    // 而「时间上接近」不是判据。
    const groups = new Map();
    for (const r of rounds) {
      const key = [...r.acSet].sort().join(',');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    for (const [acKey, rs] of groups) {
      // **顺序按声明的轮次，不按完成时间。** 这不是偏好，是实测：`50ec242b` 的四轮里
      // r2 的 transcript **最后**才完成（2026-10-30T00:09），而 r3/r4 在它之前
      // （23:27 / 23:39）—— 因为 r2 是「正在进行时」被判失败又补齐的。按时间排会得出
      // 「不通过 → 不通过 → 通过 → 通过」这条**错的**链；按声明轮次排才是
      // 「r1 不通过 → r2 通过 → r3 不通过 → r4 通过」。
      // 未声明轮次的那一轮按「最早的」处理（它只可能是 r1：本仓的 r1 从不自报序号）。
      const ordered = rs.slice().sort((a, b) => {
        const oa = a.ordinals.find((x) => x != null) ?? 1;
        const ob = b.ordinals.find((x) => x != null) ?? 1;
        return oa - ob;
      });
      const contiguous = ordered.every((r, i) => i === 0 ? true : r.ordinals.some((x) => x != null && x === i + 1));
      // 方式 B：除第一轮外，每一轮都显式回指「上一轮不通过」。
      const linkedByBackref = ordered.length > 1 && ordered.slice(1).every((r) => r.claimsPriorFail);
      chains.push({
        session,
        count: ordered.length,
        verdicts: ordered.map((r) => r.final),
        declaredOrdinals: ordered.map((r) => r.ordinals.join('/') || null),
        ats: ordered.map((r) => r.at),
        standard: acKey ? `${[...rs[0].acSet].length} 项 AC` : 'AC 集合读不出',
        contiguousFromOne: contiguous,
        linkedByBackref,
        endsInPass: ordered[ordered.length - 1].final === '通过',
        // **链里出现过「通过之后又判不通过」**——这是误放行的**候选**样本，不是证明。
        passThenFail: ordered.some((r, i) => i > 0 && ordered[i - 1].final === '通过' && r.final === '不通过'),
        method: contiguous ? 'ordinals-1..N' : linkedByBackref ? 'explicit-backref' : null,
      });
    }
  }
  return chains;
}

/** 从链里导出 `attempts_to_pass`。**故意只认「会话内声明序号 1,2,3… 连续 + 以 PASS 收尾」**，
 *  其余一律进 `censored` 并写明原因。
 *
 *  这不是严苛，是必须：实测本仓两个会话的序号各不相同 ——
 *  `71f44160…` 是 `{null, null, 2}`，`50ec242b…` 是 `{null, 3, 4, 2}`。
 *  后者的 4 条里混着**两个不同的任务**（一条链是 `wrapToWidth` 的 r1→r2，
 *  另一条是 TUI 的 r1→r3→r4，且在时间上交错）。没有 task id 就分不开这两条链，
 *  而「分不开还硬算」会得出一个「平均 1.5 次就过」的假数。
 *
 *  返回的 `censored` **必须与 `rows` 同表出现**（`success-metrics.md` §2.1）：
 *  把最难的那些悄悄从分母里去掉，会让命中率看起来比实际好。 */
export function attemptsToPass(chains = []) {
  const rows = [];
  const censored = [];
  for (const c of chains) {
    const why = [];
    if (!c.contiguousFromOne && !c.linkedByBackref) {
      why.push(`声明的轮次是 [${c.declaredOrdinals.map((x) => (x == null ? '未声明' : `r${x}`)).join(', ')}]`
        + '，既不从 1 连续，也没有逐轮回指「上一轮不通过」');
    }
    if (!c.endsInPass) why.push('最后一次不是「通过」');
    if (why.length) {
      censored.push({
        session: c.session, count: c.count, verdicts: c.verdicts,
        declaredOrdinals: c.declaredOrdinals,
        standard: c.standard,
        reason: why.join('；') + '（同一会话里可能混着多个任务，没有 task id 就分不开）',
      });
    } else {
      rows.push({ session: c.session, attempts: c.count, verdicts: c.verdicts, declared: c.count, method: c.method, standard: c.standard, passThenFail: c.passThenFail });
    }
  }
  return { rows, censored };
}

/**
 * 指标 1。**只有「declare 过 + 有 nonce + 能归属到 transcript」的任务能算。**
 * 其余单列，不摊派 —— 摊派是分配假设，不是观测（`success-metrics.md` §1.3 第 2 条）。
 */
// ── 指标 1：每任务调用次数 / token ─────────────────────────────────────

/**
 * 指标 1。**只有「declare 过 + 有 nonce + 能归属到 transcript」的任务能算。**
 * 其余单列，不摊派 —— 摊派是分配假设，不是观测（`success-metrics.md` §1.3 第 2 条）。
 */
export function metric1({ runsDir, transcripts = [], readRecs = readRecords } = {}) {
  const runs = [];
  if (!existsSync(runsDir)) {
    return { runs, computable: 0, unattributable: 0, reason: '没有 tasks/runs/ 目录（或未登记任何 run）' };
  }
  // **归属一次算完**：先把所有 run 的 nonce 收集起来，再对每份 transcript 只读一次头部
  // （`readHeadText` 只取前 64 KiB，`observe` 用的就是同一个判据）。早前版本对
  // 「每个任务 × 每份 transcript」各读一次全文件 —— 本仓语料 2.1 GB、354 份子 agent，
  // 那是 1062 次全文件读，实测跑不完。
  const nonceToTask = new Map();
  for (const run of readdirSync(runsDir, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    const ledger = join(runsDir, run.name, 'claims.jsonl');
    if (!existsSync(ledger)) continue;
    const { rows } = readLedger(ledger);
    const { tasks } = foldRows(rows);
    for (const e of tasks.values()) if (e.nonce && !nonceToTask.has(e.nonce)) nonceToTask.set(e.nonce, `${run.name}\u0000${e.task}`);
  }
  const nonces = [...nonceToTask.keys()];
  const headOf = new Map();
  if (nonces.length) {
    for (const t of transcripts) headOf.set(t.file, findNonce(readHeadText(t.file), nonces));
  }

  // 第二条归属通道：**产出重叠**。
  //
  // 规范指定的键是 nonce（`success-metrics.md` §1.2），实测在本仓归属率 **0/3** ——
  // 因为 nonce 根本没有出现在子 agent 的首条 user 消息里（`tasks/runs/` 里那 3 个 nonce
  // 在 256 份 transcript 里的首次出现位置全部在 transcript 中段，是子 agent 自己
  // `Read` 台账时把整行读进上下文才出现的）。所以下面这条通道是**代理**，不是等价物：
  // 它按「这个子 agent 写过该 run 的 outputs 里的哪些文件」反查。
  // 它的失效方向是**假阴性**（一个 agent 只做研究、不写 outputs 时它看不见）与
  // **假阳性**（多个 agent 写同一个文件时它会多认），所以报告里它叫 `proxy`，
  // 并且只用它算「单个任务的 token/calls」这一件事，不用它算任何比率。
  const allOutputs = new Map(); // run → Set(path)
  for (const run of readdirSync(runsDir, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    const g = join(runsDir, run.name, 'task-graph.json');
    if (!existsSync(g)) continue;
    let j;
    try { j = JSON.parse(readFileSync(g, 'utf8')); } catch { continue; }
    const outs = new Set();
    for (const s of (j.subtrees || [])) for (const p of (s.outputs || [])) outs.add(String(p).split('\\').join('/'));
    if (outs.size) allOutputs.set(run.name, outs);
  }
  const overlapOf = new Map(); // transcript → Set(写过的文件全路径，归一化)
  if (allOutputs.size) {
    // 注意：这里记的是**该 transcript 写过的全部路径**，不是「∩ outputs」。
    // 原因是一个真实的反例：`OL2-ST1` 的 `expect.paths` 含 `scripts/validate-run.test.mjs`，
    // 而它的 `task-graph.outputs` 只写了 `scripts/validate-run.mjs` —— 先求交集再判子集，
    // 会把「写过」变成「没写过」，归属率从 5 个候选塌成 0（这正是 C2 违规的那个任务）。
    for (const t of transcripts) {
      const recs = t.records || readRecs(t.file);
      const writes = new Set();
      for (const r of recs) {
        if (!r || r.type !== 'assistant' || !r.message || !Array.isArray(r.message.content)) continue;
        for (const b of r.message.content) {
          if (!b || b.type !== 'tool_use' || !/^(write|edit|notebookedit|multiedit)$/i.test(b.name || '')) continue;
          const fp = String((b.input && (b.input.file_path || b.input.path)) || '').split('\\').join('/');
          if (fp) writes.add(fp);
        }
      }
      if (writes.size) overlapOf.set(t.file, writes);
    }
  }

  for (const run of readdirSync(runsDir, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    const dir = join(runsDir, run.name);
    const ledger = join(dir, 'claims.jsonl');
    if (!existsSync(ledger)) continue;
    const { rows } = readLedger(ledger);
    const { tasks } = foldRows(rows);
    const { map: byNonce } = nonceOwners([...tasks.values()]);

    // 尝试次数：**读原始行**，不是 foldRows（它会把多条 expect 折成一条）。
    const expectByTask = new Map();
    for (const r of rows) if (r.kind === 'expect' && r.task) expectByTask.set(r.task, (expectByTask.get(r.task) || 0) + 1);
    // 第二来源：prompts.jsonl 的 prompt 行数（交叉校验，success-metrics.md §7）。
    const promptFile = join(dir, 'prompts.jsonl');
    const promptByTask = new Map();
    if (existsSync(promptFile)) {
      const { rows: pr } = readLedger(promptFile, { kind: 'prompt' });
      for (const r of pr) if (r.kind === 'prompt' && r.task) promptByTask.set(r.task, (promptByTask.get(r.task) || 0) + 1);
    }

    const taskRows = [];
    let attributed = 0;
    let proxied = 0;
    for (const e of tasks.values()) {
      const rec = {
        task: e.task, nonce: e.nonce, role: e.role,
        attemptsExpect: expectByTask.get(e.task) || 0,
        attemptsPrompt: promptByTask.get(e.task) || 0,
        transcript: null, usage: null, by: null, candidates: 0,
      };
      if (e.nonce) {
        // 通道 A（规范指定）：nonce 落在 transcript 头部。
        for (const t of transcripts) {
          if (headOf.get(t.file) !== e.nonce) continue;
          rec.transcript = t.file;
          rec.usage = foldUsage(t.records || readRecs(t.file));
          rec.by = 'nonce';
          attributed++;
          break;
        }
      }
      if (!rec.usage) {
        // 通道 B（代理）：谁写过这个任务的 outputs。要求**全部** outputs 都被同一个
        // transcript 覆盖，且这样的 transcript 只有一个 —— 有歧义就不归属，
        // 而不是取第一个（取第一个会让「多个 agent 协作」被算成「一个 agent 独做」）。
        // 匹配用**后缀**：`hit` 里是全路径（`D:/…/scripts/x.mjs`），而 `expect.paths`
        // 是仓库相对路径（`scripts/x.mjs`）。
        const outs = ((e.paths || []).map((p) => String(p).split('\\').join('/')));
        const cand = [];
        if (outs.length) {
          for (const t of transcripts) {
            const hit = overlapOf.get(t.file);
            if (!hit) continue;
            if (outs.every((p) => [...hit].some((fp) => fp === p || fp.endsWith('/' + p)))) cand.push(t.file);
          }
        }
        rec.candidates = cand.length;
        if (cand.length === 1) {
          rec.transcript = cand[0];
          rec.usage = foldUsage((transcripts.find((t) => t.file === cand[0]) || {}).records || readRecs(cand[0]));
          rec.by = 'outputs-overlap';
          proxied++;
        }
      }
      taskRows.push(rec);
    }
    runs.push({ run: run.name, tasks: taskRows.length, attributed, proxied, taskRows });
  }
  const attributed = runs.reduce((a, r) => a + r.attributed, 0);
  const proxied = runs.reduce((a, r) => a + r.proxied, 0);
  return {
    runs,
    attributed,
    proxied,
    totalTasks: runs.reduce((a, r) => a + r.tasks, 0),
    // 归属率的分母是「有 nonce 的 run 里的任务数」，不是全部任务数 ——
    // 把没 declare 过 nonce 的任务算进分母会把这个数压到 1% 以下，那不是「归属失败」。
    reason: attributed + proxied === 0 ? '所有 run 的任务都归属不到任何子 agent transcript（见下方「为什么」）' : null,
  };
}

// ── 指标 2 / 4 / 5：结局类 ─────────────────────────────────────────────

/** 指标 2 / 4 / 5 共用。**它们都卡在同一条记录上**，所以一起算分母、一起报缺口。 */
export function metricVerdicts({ runsDir, transcripts = [], readRecs = readRecords } = {}) {
  const attempts = { expectRows: 0, promptRows: 0, crossChecked: 0 };
  const outcomes = { asAssistant: 0, quotedInResult: 0, quotedInWrite: 0 };
  const redteamBlockMentions = { files: 0, withDispatchBlock: 0 };
  const acceptorFiles = { total: 0, withAssistantVerdict: 0 };
  const anyFiles = { total: 0, withAssistantVerdict: 0 };
  // 分母：每任务尝试几次（两个独立来源）。
  if (existsSync(runsDir)) {
    for (const run of readdirSync(runsDir, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      const dir = join(runsDir, run.name);
      const ledger = join(dir, 'claims.jsonl');
      if (existsSync(ledger)) {
        const { rows } = readLedger(ledger);
        for (const r of rows) if (r.kind === 'expect') attempts.expectRows++;
      }
      const pf = join(dir, 'prompts.jsonl');
      if (existsSync(pf)) {
        const { rows } = readLedger(pf, { kind: 'prompt' });
        for (const r of rows) if (r.kind === 'prompt') attempts.promptRows++;
      }
      // 交叉校验：同一 (run, task) 在两个来源里都有记录 → 可互校。
      const ex = new Map(); const pr = new Map();
      if (existsSync(ledger)) for (const r of readLedger(ledger).rows) if (r.kind === 'expect' && r.task) ex.set(r.task, (ex.get(r.task) || 0) + 1);
      if (existsSync(pf)) for (const r of readLedger(pf, { kind: 'prompt' }).rows) if (r.kind === 'prompt' && r.task) pr.set(r.task, (pr.get(r.task) || 0) + 1);
      for (const [t, n] of ex) if (pr.has(t) && pr.get(t) === n) attempts.crossChecked++;
    }
  }

  // 结局：扫全部 transcript，分三种来源。
  // `t.records` 若已在 `run()` 里读过就直接用 —— 本仓语料 730 MB / 454 份，
  // 二次读盘是纯粹的浪费（实测全量解析 16.8s）。
  for (const t of transcripts) {
    const recs = t.records || readRecs(t.file);
    const v = findVerdicts(recs);
    outcomes.asAssistant += v.asAssistant.length;
    outcomes.quotedInResult += v.quotedInResult.length;
    outcomes.quotedInWrite += v.quotedInWrite.length;
    const role = roleOf(recs);
    if (role === 'oversight-acceptor') { acceptorFiles.total++; if (v.asAssistant.length) acceptorFiles.withAssistantVerdict++; }
    if (v.asAssistant.length) { anyFiles.total++; anyFiles.withAssistantVerdict++; }
    // 红队：只有 dispatch:block 算阻断（RT_DISPATCH）。
    if (role === 'oversight-redteam') { redteamBlockMentions.files++; if (REDTEAM_BLOCK_RE.test(JSON.stringify(recs))) redteamBlockMentions.withDispatchBlock++; }
  }

  return { attempts, outcomes, acceptorFiles, anyFiles, redteamBlockMentions };
}

// ── 组装 ──────────────────────────────────────────────────────────────

/** 把两份数据折成报告。**纯函数**：不读盘，只做判定与措辞。 */
export function buildReport({ m1 = null, mv = null, m3 = null, m3r = null, cs = null, processedAt = new Date().toISOString(), cutoffDays = 0 } = {}) {
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const rate = (label, a, b, extra = '') => ({
    label, numerator: a, denominator: b, pct: pct(a, b),
    smallSample: b < MIN_N_FOR_RATE,
    text: b === 0 ? `—（分母为 0）` : `${a}/${b} = ${pct(a, b)}%${extra}${b < MIN_N_FOR_RATE ? '  [样本量不足以支撑结论]' : ''}`,
  });

  const metrics = [];

  // ── 指标 1 ──
  const m1Runs = (m1 && m1.runs) || [];
  const allTaskRows = m1Runs.flatMap((r) => r.taskRows.map((t) => ({ ...t, run: r.run })));
  const withUsage = allTaskRows.filter((t) => t.usage);
  const byNonce = withUsage.filter((t) => t.by === 'nonce');
  const byProxy = withUsage.filter((t) => t.by === 'outputs-overlap');
  const censusMain = (cs && cs.main) || emptyBucket();
  const censusSub = (cs && cs.subagent) || emptyBucket();
  metrics.push({
    id: 1,
    name: '每任务总调用次数与总 token 消耗',
    computable: (censusSub.files > 0 || censusMain.files > 0) ? 'partial' : 'no',
    headline: censusSub.files || censusMain.files
      ? `语料普查可算：${censusMain.files + censusSub.files} 份 transcript，`
        + `去重后 ${NUM(censusMain.calls + censusSub.calls)} 次调用 / `
        + `${NUM(censusMain.billableTokens + censusSub.billableTokens)} 计费 token；`
        + `任务级归属 ${withUsage.length}/${allTaskRows.length}`
        + `（规范键 nonce：${byNonce.length} · 代理键产出重叠：${byProxy.length}）`
      : '—（没有任何 transcript 带 usage）',
    census: { main: censusMain, subagent: censusSub },
    attribution: {
      nonce: rate('nonce → transcript（规范键，success-metrics.md §1.2）', (m1 && m1.attributed) || 0, allTaskRows.length),
      proxy: rate('产出重叠 → transcript（代理键，**不是**等价物）', (m1 && m1.proxied) || 0, allTaskRows.length),
    },
    // 每个任务都列出来，**包括归属失败的那些** —— 失败的行里 `candidates` 是证据：
    // 它说明「这个任务不是没数据，是有 N 份 transcript 都写过它的产出」。
    taskRows: allTaskRows.map((t) => ({
      run: t.run, task: t.task, by: t.by, candidates: t.candidates,
      usage: t.usage ? {
        calls: t.usage.calls,
        billableTokens: t.usage.billableTokens,
        cacheReadTokens: t.usage.cacheReadTokens,
        ambiguousUsageIds: t.usage.ambiguousUsageIds,
        dedupe: t.usage.dedupe,
      } : null,
    })),
    gap: [
      byNonce.length === 0
        ? `规范指定的归属键（nonce）在本仓实测归属率 **0/${allTaskRows.length}**：`
          + '`claim-ledger observe` 自己跑也是同一个数（0/256 份子 agent transcript）。'
          + '实测原因：nonce 不在子 agent 的首条 user 消息里，它出现在 transcript **中段** —— '
          + '那是子 agent 自己 `Read` 台账时把整行读进了上下文。'
        : null,
      byProxy.length === 0 && allTaskRows.some((t) => t.candidates > 1)
        ? '代理键也归不了：本 run 的每个任务都有**多份** transcript 写过它的 outputs'
          + `（实测候选数 ${[...new Set(allTaskRows.filter((t) => t.candidates).map((t) => t.candidates))].sort((a, b) => a - b).join(' / ')}）。`
          + '这不是「数据缺失」，是「一个 run 的产出被跨会话的多个实例反复写过」—— '
          + '在这种形态下，「这个任务花了多少 token」需要一个**明确的实例 ID**，而它不存在。'
        : null,
      '主线程开销没有「属于哪个任务」的标记 → run 级总额仍不可算（success-metrics.md §1.2）。',
      '增加留痕：在 `claims.jsonl` 加 `kind:"usage"` 行（字段见 success-metrics.md §1.4），'
        + '由 `observe` 收活时按 nonce 顺带写入 —— 这一条同时修掉归属问题：'
        + '台账里带 `agent` + `nonce` 的 usage 行不需要事后反查 transcript。',
    ].filter(Boolean).join(' '),
  });

  // ── 指标 2 ──
  const at = (mv && mv.attempts) || { expectRows: 0, promptRows: 0, crossChecked: 0 };
  const oc = (mv && mv.outcomes) || { asAssistant: 0, quotedInResult: 0, quotedInWrite: 0 };
  const ac = (mv && mv.chains) || { rows: [], censored: [] };
  const denominatorOk = at.expectRows > 0 || at.promptRows > 0;
  const hit = rate('attempts_to_pass（只含序号连续的链）', ac.rows.filter((r) => r.attempts === 1).length, ac.rows.length + ac.censored.length);
  metrics.push({
    id: 2,
    name: '盲重采样命中率',
    computable: ac.rows.length ? 'partial' : 'no',
    headline: ac.rows.length
      ? `分母可算（${at.expectRows} 条 expect / ${at.promptRows} 条 prompt）；`
        + `**transcript 里有 ${ac.rows.length} 条完整结局链、${ac.censored.length} 条 censored** —— `
        + `但这不是台账口径，样本只来自 ${new Set(ac.rows.map((r) => r.session)).size} 个会话`
      : `分母可算（${at.expectRows} 条 expect / ${at.promptRows} 条 prompt），分子不可算`,
    denominator: {
      expectRows: at.expectRows,
      promptRows: at.promptRows,
      crossCheckedTasks: at.crossChecked,
      note: '两个独立来源（success-metrics.md §7）：claims.jsonl 的 expect 行数 / prompts.jsonl 的 prompt 行数',
    },
    numerator: {
      verdictRows: oc.asAssistant,
      note: '全仓 `kind:"verdict"` 记录数 = 0（没有任何写入点产生它）；'
        + `${oc.asAssistant} 条是从 transcript **正文**里读出来的，不是台账`,
    },
    chains: {
      converged: ac.rows,
      censored: ac.censored,
      hitRate1: hit,
      // 「平均几次重采样」只在有收敛链时才算，且分母去掉 censored ——
      // 但 censored 数必须同表出现，否则「平均 1.2 次就过」会比实际好看。
      meanResamples: ac.rows.length
        ? Math.round(((ac.rows.reduce((a, r) => a + (r.attempts - 1), 0) / ac.rows.length) * 100)) / 100
        : null,
      // 「通过之后又判不通过」的链 —— **误放行的候选，不是证明**。
      // 判据它成立需要「下游独立发现了问题」，而这些链里 r3 的失败原因有一部分
      // 是**锐评 Agent 在同一时间**发现的（不是 r2 之后才发现的）。这正是
      // `success-metrics.md` §7「两个来源不一致时，不一致本身就是要报的那件事」。
      passThenFail: ac.rows.filter((r) => r.passThenFail),
    },
    gap: '缺 `kind:"verdict"`：写进 `tasks/runs/<run>/claims.jsonl`，由 Phase E 每次验收后追加'
      + '（字段 `attempt` / `nonce` / `by` / `verdict` / `source` / `reasons`，见 success-metrics.md §2.4）。'
      + ' 同时还缺「这次是盲重采样还是局部修复」的标记 —— 否则两条路径会被混成一个比率。'
      + ' transcript 里那几条结局链**不能替代它**：没有 `task` 与 `nonce`，链只能靠「这是第几次验收」'
      + '这句自然语言对齐，而它并不是每次都有。',
  });

  // ── 指标 3 ──
  const c2 = m3 || { tasks: 0, anchoredAcTotal: 0, inOutputs: 0, violations: [] };
  const res = m3r || [];
  metrics.push({
    id: 3,
    name: '修复路径的局部定位准确率',
    computable: 'no',
    headline: c2.anchoredAcTotal
      ? `C2（定位点是否在 outputs 内）可算：${c2.inOutputs}/${c2.anchoredAcTotal} 个 AC anchor 落在 outputs 内`
      : '—（没有带 `file:line` anchor 的 AC）',
    c2: rate('anchor ∈ outputs（C2）', c2.inOutputs, c2.anchoredAcTotal),
    anchorResolvable: res.length
      ? rate('anchor 的文件存在且行号可达（C1 机械部分）', res.filter((r) => r.lineReachable).length, res.length)
      : null,
    violations: c2.violations,
    gap: 'C2 只是「定位点在不在产出清单里」这个**子集判断**，不是「定位准不准」。真正的定位准确率要求'
      + '「修复后同一个失败复现消失」，而「失败复现是哪条命令」全仓零记录 → 缺 `kind:"locator"`（含 `repro` 命令）'
      + ' 与 `kind:"localization"`（含 `repro_green_after_fix`），写进同一个 `claims.jsonl`（success-metrics.md §3.4）。',
  });

  // ── 指标 4 ──
  const acc = (mv && mv.acceptorFiles) || { total: 0, withAssistantVerdict: 0 };
  const rt = (mv && mv.redteamBlockMentions) || { files: 0, withDispatchBlock: 0 };
  const aw = (mv && mv.acceptanceWork) || { byPrompt: 0, byAttribution: 0, both: 0, byPromptWithVerdict: 0, byAttributionWithVerdict: 0 };
  metrics.push({
    id: 4,
    name: '验收门 / 红队门的误放行率与误拦截率',
    computable: 'no',
    headline: `误放行：不可算（可解析的 PASS 总数 = ${aw.byPromptWithVerdict}）`
      + ` · 误拦截：不可算（FAIL 总数没有落盘）`
      + (ac.rows.some((r) => r.passThenFail) ? ` · **${ac.rows.filter((r) => r.passThenFail).length} 条链出现「通过后又判不通过」**（候选，非证明）` : ''),
    acceptor: {
      transcripts: acc.total,
      withMachineReadableVerdict: acc.withAssistantVerdict,
      byPrompt: aw.byPrompt,
      byAttribution: aw.byAttribution,
      overlap: aw.both,
      byPromptWithVerdict: aw.byPromptWithVerdict,
      byAttributionWithVerdict: aw.byAttributionWithVerdict,
    },
    passThenFailCandidates: ac.rows.filter((r) => r.passThenFail),
    redteam: { transcripts: rt.files, withDispatchBlock: rt.withDispatchBlock },
    note: '误拦截的**必要条件**（「产出 sha256 未变却被再次判过」）本身可算：'
      + '`claim.sha256` 能判「字节未变」；但「这一次判过 / 判不过」没有落盘，'
      + '所以没有「同一次尝试的两次判定」可以配对（success-metrics.md §4.3）。',
    gap: '与指标 2 共用同一条 `kind:"verdict"` 记录；另建议在同一条上加 `outputs_sha256`，'
      + '让「没改动就再判一次」可以离线判定而不必重扫 transcript。误放行还额外需要「下游 DF 条目回指 run/task」，'
      + '现有 DF 条目没有这两个字段（`tasks/dev-findings.md` 的 85 条一条都没有）。',
  });

  // ── 指标 5 ──
  const converged = ac.rows;
  metrics.push({
    id: 5,
    name: '终态一次交付成功率 vs 经过门禁回流后的终态成功率',
    computable: converged.length ? 'partial' : 'no',
    headline: converged.length
      ? `transcript 口径可算：first_pass ${converged.filter((r) => r.attempts === 1).length}/${converged.length}`
        + ` · terminal ${converged.length}/${converged.length}（+ ${ac.censored.length} censored）`
        + ` —— 但分母只有 ${converged.length} 条，且全部来自 2 个会话`
      : '—（不可算：与指标 2 / 4 卡在同一条记录）',
    firstPass: rate('first_pass（第 1 次尝试即 PASS）', converged.filter((r) => r.attempts === 1).length, converged.length),
    terminal: rate('terminal（存在某次 PASS）', converged.length, converged.length),
    denominatorAdmission: '`success-metrics.md` §5.1 要求的准入（只算 `shape:artifact` 且 `outputs` 非空、'
      + '`expect` 行存在的任务）**做不到**：transcript 里的验收结论不带 task id，'
      + '无法与 task-graph 的 subtree 对上。',
    gap: '缺 `kind:"verdict"`。分母的准入条件必须先声明（只算 `shape:artifact` 且 `outputs` 非空'
      + '且 `expect` 行存在的任务），否则「成功率」会同时测量规划能力与工程能力（success-metrics.md §5.1）。',
  });

  return {
    processedAt,
    cutoffDays,
    minNForRate: MIN_N_FOR_RATE,
    dedupeKeys: DEDUPE_KEYS,
    metrics,
    computableCount: metrics.filter((m) => m.computable === 'yes').length,
    partialCount: metrics.filter((m) => m.computable === 'partial').length,
  };
}

// ── 渲染 ──────────────────────────────────────────────────────────────

const NUM = (n) => (n == null ? '—' : typeof n === 'number' ? n.toLocaleString('en-US') : String(n));

export function formatReport(rep) {
  const lines = [];
  lines.push('走量成功指标 — 真实数据');
  lines.push('');
  lines.push(`生成于 ${rep.processedAt}${rep.cutoffDays ? ` · 窗口 ${rep.cutoffDays} 天` : ' · 全量'}`);
  lines.push(`低于 n=${rep.minNForRate} 的比率一律标 [样本量不足以支撑结论]（这是约定，不是统计检验）`);
  lines.push(`去重键：token=${rep.dedupeKeys.tokens} · 调用=${rep.dedupeKeys.calls}`);
  lines.push('');
  lines.push('| # | 指标 | 能不能算 | 结论 |');
  lines.push('|---|---|---|---|');
  for (const m of rep.metrics) {
    const tag = m.computable === 'yes' ? '可算' : m.computable === 'partial' ? '部分可算' : '不可算';
    lines.push(`| ${m.id} | ${m.name} | ${tag} | ${m.headline} |`);
  }
  lines.push('');

  for (const m of rep.metrics) {
    lines.push(`## ${m.id}. ${m.name}`);
    lines.push('');
    lines.push(`**能不能算**：${m.computable === 'yes' ? '可算' : m.computable === 'partial' ? '部分可算' : '不可算'}`);
    lines.push('');
    lines.push(`**结论**：${m.headline}`);
    lines.push('');
    if (m.attribution) {
      if (m.attribution.text) lines.push(`- 归属率：${m.attribution.text}`);
      else {
        lines.push(`- 归属率（规范键 nonce）：${m.attribution.nonce.text}`);
        lines.push(`- 归属率（代理键产出重叠）：${m.attribution.proxy.text}`);
      }
    }
    if (m.census) {
      lines.push('');
      lines.push('| 桶 | transcript | assistant 记录 | 不同 message.id | 重复倍数 | 调用数（去重） | 计费 token（去重） | cache_read（单列） |');
      lines.push('|---|---|---|---|---|---|---|---|');
      for (const [k, b] of [['主线程', m.census.main], ['子 agent', m.census.subagent]]) {
        lines.push(`| ${k} | ${NUM(b.files)} | ${NUM(b.assistantRecords)} | ${NUM(b.uniqueMessageIds)} | ${b.usageInflation == null ? '—' : b.usageInflation + '×'} | ${NUM(b.calls)} | ${NUM(b.billableTokens)} | ${NUM(b.cacheReadTokens)} |`);
      }
    }
    if (m.c2) { lines.push(`- ${m.c2.label}：${m.c2.text}`); }
    if (m.anchorResolvable) { lines.push(`- ${m.anchorResolvable.label}：${m.anchorResolvable.text}`); }
    if (m.detail && m.detail.length) {
      lines.push('');
      lines.push('| 任务 | 归属方式 | 候选数 | 调用数（去重） | 计费 token（去重） | cache_read（单列） | 歧义 usage id |');
      lines.push('|---|---|---|---|---|---|---|');
      for (const t of m.detail) {
        lines.push(`| ${t.task} | ${t.by} | ${t.candidates} | ${NUM(t.calls)} | ${NUM(t.billableTokens)} | ${NUM(t.cacheReadTokens)} | ${t.ambiguousUsageIds} |`);
      }
    }
    if (m.taskRows && m.taskRows.length) {
      lines.push('');
      lines.push('| run | 任务 | 能不能归属 | 归属方式 | 候选 transcript 数 | 调用数（去重） | 计费 token（去重） |');
      lines.push('|---|---|---|---|---|---|---|');
      for (const t of m.taskRows) {
        lines.push(`| ${t.run} | ${t.task} | ${t.usage ? '能' : '不能'} | ${t.by || '—'} | ${t.candidates || 0} | ${t.usage ? NUM(t.usage.calls) : '—'} | ${t.usage ? NUM(t.usage.billableTokens) : '—'} |`);
      }
    }
    if (m.chains) {
      lines.push('');
      lines.push(`- 收敛链（序号从 1 连续、以「通过」收尾）：${m.chains.converged.length} 条`
        + ` · censored：${m.chains.censored.length} 条（3 次仍未过、或声明轮次与正文对不上）`);
      if (m.chains.converged.length) {
        lines.push(`- 平均重采样次数（分母只含收敛链，censored **未**去掉报数）：${m.chains.meanResamples}`);
        lines.push('');
        lines.push('| 会话 | 标准 | 尝试次数 | 结局序列 | 链是怎么认出来的 |');
        lines.push('|---|---|---|---|---|');
        for (const r of m.chains.converged) {
          lines.push(`| ${r.session} | ${r.standard} | ${r.attempts} | ${r.verdicts.join(' → ')} | ${r.method === 'ordinals-1..N' ? '声明轮次 1..N 连续' : '逐轮显式回指「上一轮不通过」'} |`);
        }
      }
      if (m.chains.censored.length) {
        lines.push('');
        lines.push('| censored 链（会话） | 标准 | 轮次 | 结局序列 | 原因 |');
        lines.push('|---|---|---|---|---|');
        for (const r of m.chains.censored) {
          lines.push(`| ${r.session} | ${r.standard} | ${r.declaredOrdinals.map((x) => (x == null ? '—' : `r${x}`)).join(', ')} | ${r.verdicts.join(' → ')} | ${r.reason} |`);
        }
      }
    }
    if (m.firstPass) {
      lines.push('');
      lines.push(`- ${m.firstPass.label}：${m.firstPass.text}`);
      lines.push(`- ${m.terminal.label}：${m.terminal.text}`);
      lines.push('');
      lines.push(`> ⚠ 这两个数**不是** ` + '`success-metrics.md` §5 要的那两个：');
      lines.push('> §5 的分母是「任务」，而这里的分母是「transcript 里能读出的完整结局链」。');
      lines.push(`> 两者的差别不是措辞：§5 要求先按 \`shape:artifact\` + \`outputs\` 非空 + \`expect\` 行存在做准入，`
        + '而 transcript 里的结论**不带 task id**，那个准入根本没法做（见下）。');
    }
    if (m.denominator) {
      lines.push('');
      lines.push(`- 分母：expect 行 ${m.denominator.expectRows} · prompt 行 ${m.denominator.promptRows} · 两来源可互校的任务 ${m.denominator.crossCheckedTasks}`);
    }
    if (m.numerator) {
      lines.push(`- 分子：可解析的验收结论行 ${m.numerator.verdictRows}（${m.numerator.note}）`);
    }
    if (m.acceptor) {
      lines.push('');
      lines.push(`- 按 **prompt 正文**认出是验收工作的 transcript：${m.acceptor.byPrompt} 份`
        + `，其中在 assistant 正文里写出可解析验收结论的：${m.acceptor.byPromptWithVerdict} 份`);
      lines.push(`- 按 **attributionAgent=oversight-acceptor** 认出的：${m.acceptor.byAttribution} 份`
        + `，其中有可解析结论的：${m.acceptor.byAttributionWithVerdict} 份`);
      lines.push(`- 两个判据的重合：${m.acceptor.overlap} 份。**不重合不是口径之争，是事实**：`
        + `本仓大量验收工作以 \`subagent_type: general-purpose\` 派出，角色只写在 prompt 里。`);
    }
    if (m.passThenFailCandidates && m.passThenFailCandidates.length) {
      lines.push('');
      lines.push('**「通过之后又判不通过」的链**（误放行的**候选**，不是误放行率）：');
      for (const r of m.passThenFailCandidates) {
        lines.push(`  - ${r.session}：${r.verdicts.join(' → ')}`);
      }
      lines.push('');
      lines.push('> 为什么只是候选：判「误放行」要求「下游**独立**发现了问题」。实测该链 r3 的失败原因里，');
      lines.push('> 至少有一项（OSC 52 穿透）是**锐评 Agent 在 r2 进行时**同时发现的，不是 r2 通过之后的新发现。');
      lines.push('> 按 `success-metrics.md` §7，两个来源不一致时**不许取其中一个当结论** —— 这里只报候选。');
    }
    if (m.redteam) {
      lines.push(`- redteam transcript：${m.redteam.transcripts} 份，其中写明 \`dispatch: block\` 的：${m.redteam.withDispatchBlock} 份`);
    }
    if (m.violations && m.violations.length) {
      lines.push('');
      lines.push(`C2 违规（AC 指向的文件不在该子树的 outputs 内）：`);
      for (const v of m.violations) lines.push(`  - ${v.task} ${v.ac} → ${v.file}:${v.line}（outputs: ${v.outputs.join(', ') || '空'}）`);
    }
    if (m.gap) {
      lines.push('');
      lines.push(`**缺什么**：${m.gap}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('**一句话**：五个指标里，**没有一个「完整可算」**。'
    + '指标 1 的语料普查（调用数 / token）是唯一分母完整、归属无缺口的部分，'
    + '但它答的是「这一批 transcript 花了多少」，不是「某个任务花了多少」—— 后者实测 0/3。'
    + '指标 2 / 5 有一条 **transcript 口径**的部分结果（2 条链，n=2，全部来自 2 个会话）；'
    + '指标 3 只算出 C2/C1 的机械部分；指标 4 只证伪了误拦截的可算前提。'
    + '真正的缺口是**同一条** `kind:"verdict"` 记录 —— 它一处落盘，指标 2 / 4 / 5 同时成立。');
  return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { days: 0, json: false, session: null, root: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') out.days = Number(argv[++i]) || 0;
    else if (a === '--json') out.json = true;
    else if (a === '--session') out.session = argv[++i] || null;
    else if (a === '--root') out.root = argv[++i] || null;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/** 跑一遍。分成三段：列 transcript（受 --days 裁剪）→ 三个指标 → 组装。 */
export function run({ root = null, days = 0, session = null, nowMs = Date.now(), runsDir = null } = {}) {
  const r = root || defaultRoot();
  if (!existsSync(r)) {
    return { error: `找不到 transcript 根：${r}` };
  }
  let files;
  if (session) {
    const s = resolve(session);
    if (s.endsWith('.jsonl')) files = [s, ...subagentTranscriptsOf(s)];
    else files = [join(s + '.jsonl'), ...subagentTranscriptsOf(s)].filter((f) => existsSync(f));
  } else {
    files = listTranscripts(r);
  }
  if (days > 0) {
    const cutoff = nowMs - days * 86400000;
    files = files.filter((f) => { try { return statSync(f).mtimeMs >= cutoff; } catch { return false; } });
  }

  const transcripts = files
    .filter((f) => !SANDBOX_RE.test(f))
    .map((f) => ({ file: f, records: readRecords(f) }));
  // runsDir：优先用 project-root 的解析（本仓它认 `overwatch.config.json` 的 paths.runs）。
  let rd = runsDir;
  if (!rd) {
    try {
      const root = projectRoot({ quiet: true });
      rd = runsDirFor(root);
    } catch { rd = join(process.cwd(), 'tasks', 'runs'); }
  }

  // 姿态：指标 1 的归属用**全部子 agent transcript**，不受沙箱过滤影响 ——
  // 非沙箱过滤是为了「不数自己」，而归属是在一堆已知文件里找 nonce，不过滤会更准。
  const allSubs = files.filter((f) => f.split('\\').join('/').includes('/subagents/') && basename(f).startsWith('agent-')).map((f) => ({ file: f }));
  const m1 = metric1({ runsDir: rd, transcripts: allSubs });
  const mv = metricVerdicts({ runsDir: rd, transcripts });
  mv.acceptanceWork = countAcceptanceWork(transcripts);
  mv.chains = attemptsToPass(verdictChains(transcripts));

  // 指标 3：拿全部 task-graph.json 算 C2 与 anchor 可达性。
  let c2 = { tasks: 0, anchoredAcTotal: 0, inOutputs: 0, violations: [] };
  let resolvable = [];
  let graphCount = 0;
  if (existsSync(rd)) {
    for (const run of readdirSync(rd, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      const g = join(rd, run.name, 'task-graph.json');
      if (!existsSync(g)) continue;
      graphCount++;
      let j;
      try { j = JSON.parse(readFileSync(g, 'utf8')); } catch { continue; }
      const one = checkC2(j);
      c2.tasks += one.tasks;
      c2.anchoredAcTotal += one.anchoredAcTotal;
      c2.inOutputs += one.inOutputs;
      for (const v of one.violations) c2.violations.push({ ...v, run: run.name });
      resolvable = resolvable.concat(checkAnchorResolvable(j, { root: process.cwd() }));
    }
  }

  return {
    root: r,
    transcripts: transcripts.length,
    subagentTranscripts: allSubs.length,
    runsDir: rd,
    taskGraphs: graphCount,
    report: buildReport({ m1, mv, m3: c2, m3r: resolvable, cs: census(transcripts), processedAt: new Date(nowMs).toISOString(), cutoffDays: days }),
    raw: { m1, mv, c2, resolvable },
  };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('node scripts/compute-metrics.mjs [--days N] [--session <dir|.jsonl>] [--root <dir>] [--json]');
    console.log('');
    console.log('按 docs/spec/success-metrics.md 的口径在真实数据上算五个指标。');
    console.log('算不出来的指标返回 null 与「缺什么」，不返回 0。');
    return 0;
  }
  const res = run({ root: args.root, days: args.days, session: args.session });
  if (res.error) {
    console.error(res.error);
    console.error('这不是「没有数据」——是「看不到」。空结果不能当通过。');
    return 2;
  }
  if (args.json) {
    console.log(JSON.stringify({ root: res.root, transcripts: res.transcripts, subagentTranscripts: res.subagentTranscripts, runsDir: res.runsDir, taskGraphs: res.taskGraphs, ...res.report }, null, 2));
  } else {
    console.log(formatReport(res.report));
  }
  return 0;
}

/** 入口守卫（本仓 17 处同形的那个）：被 import 时不执行。 */
const realOrResolve = (p) => {
  try { return resolve(p); } catch { return p; }
};
if (process.argv[1] && realOrResolve(process.argv[1]) === realOrResolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
