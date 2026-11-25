#!/usr/bin/env node
/**
 * dispatch-quartet.mjs — 返回格式四元组的**解析判据**（纯函数，无 I/O）。
 *
 * 为什么单独成模块，而不是留在 `check-structure.mjs` 里：
 *
 *   `check-structure.mjs` 是**只当 CLI 跑**的脚本（`CLI_SCRIPTS` 里第一项）——
 *   import 它就会执行全部门禁并 `process.exit`。而这条判据有两种错法
 *   （切片过早 / 围栏未闭合误判）**不会在当前文档上暴露**，只在有人改动
 *   文档结构时才炸。没有单测钉住它，就等于让它在下一次重构里静默失效。
 *
 *   本仓已经为同一个问题付过学费：`roles.mjs` 的 `parseFrontmatter` 原先在
 *   `check-structure.mjs` 和 `compose-agent-prompt.mjs` 里各有一份，两份对多行块
 *   的处理一致只是当时的巧合。判据必须在能被 import 的地方，才能被单独测。
 *
 * ## 它判什么
 *
 * 子 Agent 的最终返回是一个固定字段的结构，主线程按**字段名**读它。字段名少一个，
 * 下游不是「少读到一条信息」，而是读到一个不存在的东西：
 *
 *   · 少 `## 我产出的文件` → 产出对账拿不到自述，`UNREPORTED` 变成常态；
 *   · 少 `## 我认为的薄弱点` → 红队与锐评的「被禁输入」不存在（它们本靠**不看**保证独立，
 *     现在是**没得看**），独立性约束从设计退化成碰巧；
 *   · 少 `## 执行日志` → 主线程失去「它在哪停下的」的唯一可读线索。
 *
 * ## 判据为什么锚在「输出节里的第一个代码围栏」
 *
 * 两版判据先后翻车，都是「取错了判据对象」的同一个病：
 *
 *   1. **全文搜索**。`templates/dispatch.md` 里 `## 我产出的文件` 出现 **4 次**
 *      （格式块 1 次 + 正文 3 次）。删掉格式块里那一次，全文仍然有 → 门照样绿。
 *   2. **按 `^#{1,2} ` 找节边界**。围栏里**就是** `## 交付物` 这些行，于是切片在
 *      围栏第一行就结束 → 四份载体全部误报「围栏没有闭合」，而那四份文件都完好。
 *
 * 所以现在的顺序是：**先找到第一个围栏的开，再递归跳围栏**，围栏内的伪标题不算边界。
 *
 * 零依赖，纯函数。
 */

/** 输出节的标题判据。实测各载体只有一处：
 *  `## 6. 返回值格式` / `## 输出格式（强制）` / `## 输出（严格四元组，不超过 18 行）` / `## 输出（四元组）`。
 *  `###` 不算（那是子节）。 */
const OUTPUT_SECTION_RE = /^##\s*(?:\d+\.\s*)?(?:返回值格式|输出.*)$/;

/** 从整份文本里取出「输出节」那个代码围栏的**内容行**（已 trim）。
 *
 *  @param {string} text 文件全文
 *  @returns {{lines: string[]} | {error: string}}
 *    - 成功：`{ lines }` = 围栏内的行（不含围栏本身）
 *    - 失败：`{ error }`，且**必须被报红**。返回空数组是最坏的形态：
 *      调用方会把它读成「一个字段都没有」，与「读不到格式」在屏幕上同形。
 *
 *  三种失败各有各的话，因为处置不同：
 *    · 找不到输出节 → 文档结构变了
 *    · 没有围栏     → 没有可照抄的格式模板
 *    · 围栏未闭合   → 格式模板被截断了
 */
export function outputFenceLines(text) {
  // CRLF 归一放在最前面：带 `\r` 的行匹配不上 `^## ` 与行尾锚点，那会在 Windows 上
  // 把每一份载体都判成「找不到输出节」—— 一次四条误报，而文件完全没问题。
  const all = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
  const start = all.findIndex((l) => OUTPUT_SECTION_RE.test(l.trim()));
  if (start < 0) {
    return { error: '找不到「输出 / 返回值格式」节标题（`## 输出…` 或 `## N. 返回值格式`）' };
  }

  // 找节边界：跳过围栏内的行。`inFence` 按 ``` 翻转 —— 围栏内的 `## xxx` 是**内容**。
  let end = all.length;
  let inFence = false;
  for (let i = start + 1; i < all.length; i++) {
    const line = all[i].trim();
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (/^#{1,2}\s/.test(line)) { end = i; break; }
  }
  if (inFence) return { error: '「输出」节里的代码围栏没有闭合 —— 格式模板被截断了' };

  const slice = all.slice(start + 1, end);
  const openRel = slice.findIndex((l) => /^\s*```/.test(l));
  if (openRel < 0) return { error: '「输出」节里没有代码围栏 —— 没有可照抄的格式模板' };

  const body = [];
  for (let i = openRel + 1; i < slice.length; i++) {
    if (/^\s*```/.test(slice[i])) return { lines: body.map((l) => l.trim()) };
    body.push(slice[i]);
  }
  return { error: '「输出」节里的代码围栏没有闭合 —— 格式模板被截断了' };
}

/** 四元组的字段清单。**只有这四个**是 `executor` 的返回格式；
 *  `repair` 另有自己的节名（见 `check-structure.mjs` 的 `QUARTET_CARRIERS`）。
 *
 *  为什么不把它写成「所有角色的输出都要这四节」：`acceptor` 交判定表、`redteam` 交反例表、
 *  `probe` 交三选一判定 —— 而且它们**不该**有「我认为的薄弱点」（那会污染独立性）。 */
export const QUARTET_FIELDS = Object.freeze([
  '## 交付物', '## 执行日志', '## 我认为的薄弱点', '## 我产出的文件',
]);

/** 核一份文本的输出围栏里缺哪些字段。
 *
 *  @param {string} text
 *  @param {string[]} sections 该载体应当声明的字段标题（逐字）
 *  @returns {{ok: true, missing: string[]} | {ok: false, error: string}}
 *    `ok: true` 且 `missing` 非空 = 围栏存在但字段不全（**要报红**）。
 *    `ok: false` = 连围栏都取不到（**也要报红**，且原因不同）。
 */
export function quartetGaps(text, sections) {
  const got = outputFenceLines(text);
  if (got.error) return { ok: false, error: got.error };
  const want = Array.isArray(sections) ? sections : [];
  const missing = want.filter((h) => !got.lines.includes(h));
  return { ok: true, missing };
}
