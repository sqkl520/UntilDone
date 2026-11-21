#!/usr/bin/env node
/**
 * regression-count.mjs — 「全量回归测试到底有多少条」的唯一取数处。
 *
 * ## 为什么要有这个文件
 *
 * `check-structure.mjs` 的 `checkTestCount()` 原本用 `^\s*test\(` 数**源码字面量**。
 * 2026-11-21 红队实测：源码里 1873 个 `test(`，`node --test scripts/` 报 `ℹ tests 1876`。
 * 差的 3 条来自 `overwatch.test.mjs:305` 的
 *
 *     for (const [cmd, native] of [['scan', …], ['verify', …], ['tui', …], ['watch', …]]) {
 *       test(`ro 路由：${cmd} …`, () => { … });
 *     }
 *
 * ——一个 `test(` 字面量，注册出 4 条测试。于是那道门在**逼文档写一个错的数**：
 * 它守的是「文档与源码字面量一致」，不是「文档与真实条数一致」。红队的原话是
 * 「`count-equals-source` 这条原语，今天就产出一个假话」。
 *
 * ## 取数口径：真跑一遍**注册**，不跑用例
 *
 * 用 `module.registerHooks()` 把 `node:test` 换成一个只记账的替身，然后 import 每个
 * 测试文件。测试的 `test()` 调用在 **import 时**就执行（回调不执行），所以这么数出来的
 * 条数与 `node --test` 的 `ℹ tests` **逐条相等**（实测两边都是 1876）。
 *
 * 为什么不直接跑 `node --test`：全量要 52 秒。实测本模块 0.5–1.9 秒（含子进程启动），
 * 结构门从 3.1s 变成 3.8s。为什么不选「保留源码计数、改文档措辞」：那要让读者记住
 * 两个数之间差几条、为什么差，而差值是会变的——一个需要解释两遍的数字，最后会被
 * 读者当成噪音。数真实值只留一句话：「文档里那个数就是 `node --test` 报的那个数」。
 *
 * ## 判据住在这里、不住在硬门里
 *
 * 与 `link-check.mjs` / `published-paths.mjs` 同一个理由：`check-structure.mjs` 是
 * `CLI_SCRIPTS` 成员（被 import 就会跑完全部检查），判据写在里面就**没法单测**。
 * 搬出来之后 `regression-count.test.mjs` 能直接对着一个假仓库跑红→绿。
 *
 * ## 副作用
 *
 * import 测试文件会发生它们模块级的副作用。实测只有两处：
 *   · `entry-symlink.test.mjs` 在 `tasks/runs/` 下建一个临时目录，并由它自己的
 *     `after()` 回调删掉 —— 所以这里**要执行登记的 after 回调**（它们在本仓全是清理）。
 *   · 生产模块读 `OVERWATCH_STATE_DIR` 之类时可能写盘 —— 本探针在子进程里把那一族
 *     环境变量全部指到临时目录（与 `checkImportable()` 同法）。
 *
 * ## 「哪些文件算测试」必须与 `node --test <目录>` 逐字一致
 *
 * 这条是**踩出来的**：新模块最初叫 `test-count.mjs`，名字正好匹配 Node 的
 * `test-*.mjs` 模式 —— 于是全量跑时它被当成测试文件**执行了一次**（它还带了顶层
 * `console.log` 之外无副作用，但那只是运气），`ℹ tests` 因此比真实注册数多 1。
 * 一个只认 `*.test.mjs` 的计数器会把这个偏差记在**别人**头上。
 *
 * 实测 Node 22/24/26 在目录模式下的匹配集（逐个文件名验证过）：
 *   `*.test.*` / `*-test.*` / `*_test.*` / `test-*.*` / `test.*`，且**递归子目录**。
 * 这里照抄这份集合，而不是只写 `*.test.mjs`：手写一个更窄的集合，失效方式是
 * 下一次有人用 `foo-test.mjs` 命名测试文件，门数不到它，而门照样绿。
 */

import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** 这个文件名会不会被 `node --test <目录>` 当成测试文件。
 *
 *  与 Node 源码里的匹配规则同一份集合（见文件头「哪些文件算测试」）。
 *  导出是为了让测试能直接钉住它 —— 这一条判据写错的表现是「数不到」，
 *  而数不到又不会报错，只能靠断言的用例。 */
export function isNodeTestFile(name) {
  if (!/\.(mjs|cjs|js)$/.test(name)) return false;
  const base = name.replace(/\.(mjs|cjs|js)$/, '');
  return /\.test$/.test(base) || /-test$/.test(base) || /_test$/.test(base)
    || /^test-/.test(base) || base === 'test';
}

/** 递归收集 `dir` 下 Node 会当测试跑的文件（相对路径，已排序）。 */
export function nodeTestFiles(dir) {
  const out = [];
  const walk = (d, prefix) => {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries.sort()) {
      if (e === 'node_modules' || e === '.git') continue;
      const full = join(d, e);
      const relPath = prefix ? `${prefix}/${e}` : e;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, relPath);
      else if (isNodeTestFile(e)) out.push(relPath);
    }
  };
  walk(dir, '');
  return out;
}

/** 子进程里跑的探针脚本。**逐行成串**（而不是写成文件、也不是一整段模板字符串）：
 *  它与取数逻辑同生共死，改的永远只有这一处；逐行还顺带避开了「模板字符串里
 *  再写反引号注释」这个坑 —— 它让本文件连续两次编译失败，而报错位置指向的是注释。 */
function probeScript(dir) {
  return [
    'import { mkdtempSync, rmSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    'import * as nodeModule from "node:module";',
    `const DIR = ${JSON.stringify(dir)};`,
    '',
    '// 探针自己的沙箱：import 测试文件会连带 import 生产模块，它们认这几个环境变量。',
    'const sandbox = mkdtempSync(join(tmpdir(), "ow-regression-count-"));',
    'for (const k of ["OVERWATCH_STATE_DIR", "OVERWATCH_STOP_VERIFY_LOG", "OVERWATCH_STOP_VERIFY_STATE",',
    '  "OVERWATCH_STOP_VERIFY_SAMPLES", "OW_PRE_WRITE_GATE_LOG", "OVERWATCH_HOOK_DEDUPE_DIR"]) {',
    '  process.env[k] = join(sandbox, k.toLowerCase());',
    '}',
    'process.on("exit", () => { try { rmSync(sandbox, { recursive: true, force: true }); } catch {} });',
    '',
    'const state = { names: [], cleanups: [] };',
    'globalThis.__owRegressionCountProbe = state;',
    '',
    '// 替身必须把 node:test 的**整个 API 面**都补齐，不能只补 test()。',
    '// 漏一个的失效方式不是「少算几条」，而是那个测试文件在 import 阶段抛错、',
    '// 它的用例整块消失（实测：dispatch-coverage.test.mjs 用了 test.before）。',
    'const STUB_SRC = [',
    '  "const st = globalThis.__owRegressionCountProbe;",',
    '  "const record = (name) => st.names.push(typeof name === \'string\' ? name : \'<fn>\');",',
    '  "export function test(name) { record(name); }",',
    '  "for (const k of [\'skip\', \'only\', \'todo\', \'expectFailure\']) test[k] = test;",',
    '  "for (const k of [\'before\', \'after\', \'beforeEach\', \'afterEach\']) test[k] = () => {};",',
    // describe/suite 是**容器**：node --test 的 # tests 里，容器下的每条用例仍是独立一条，
    // 所以容器本身不计数，只把回调跑开，让里面的 test() 各自登记。
    '  "test.describe = (name, fn) => { if (typeof fn === \'function\') fn(); };",',
    '  "test.suite = test.describe;",',
    '  "test.it = test;",',
    '  "export const describe = test.describe;",',
    '  "export const suite = test.describe;",',
    '  "export const it = test;",',
    // 清理回调单独收：本仓的 after() 全是 rmSync 临时目录，不跑会把它们留在仓库里。
    '  "export const after = (fn) => { if (typeof fn === \'function\') st.cleanups.push(fn); };",',
    '  "export const before = () => {};",',
    '  "export const beforeEach = () => {};",',
    '  "export const afterEach = () => {};",',
    '  "export const mock = Object.assign(() => {}, {",',
    '  "  fn: () => () => {}, method: () => {}, getter: () => {}, setter: () => {},",',
    '  "  reset: () => {}, restoreAll: () => {},",',
    '  "  timers: { enable() {}, reset() {}, tick() {}, runAll() {}, setTime() {} },",',
    '  "});",',
    '  "export const getTestContext = () => ({});",',
    '  "export const run = () => {};",',
    '  "export default test;",',
    '].join("\\n");',
    'const STUB = "data:text/javascript," + encodeURIComponent(STUB_SRC);',
    '',
    '// 老 Node（< 22.15）没有 registerHooks，只有 module.register()（20.6 起）。',
    'const hook = {',
    '  resolve(spec, ctx, next) {',
    '    if (spec === "node:test") return { url: STUB, shortCircuit: true };',
    '    return next(spec, ctx);',
    '  },',
    '};',
    'let method = "registerHooks";',
    'if (typeof nodeModule.registerHooks === "function") {',
    '  nodeModule.registerHooks(hook);',
    '} else if (typeof nodeModule.register === "function") {',
    '  method = "register";',
    '  // 老路径要走独立的 loader 线程，钩子函数没法直接传，得序列化成一个模块源码。',
    '  const loaderSrc = "export async function resolve(spec, ctx, next) {"',
    '    + " if (spec === \\"node:test\\") return { url: " + JSON.stringify(STUB) + ", shortCircuit: true };"',
    '    + " return next(spec, ctx); }";',
    '  nodeModule.register("data:text/javascript," + encodeURIComponent(loaderSrc));',
    '} else {',
    '  console.log("@@COUNT@@" + JSON.stringify({ error: "no-module-hooks", method: "none" }));',
    '  process.exit(0);',
    '}',
    '',
    `const files = ${JSON.stringify(nodeTestFiles(dir))};`,
    '// 并行 import：import 本身只花几十毫秒，整轮却受最慢那个文件主导',
    '// （实测串行 939ms、并行 470ms；pre-write-gate 一个就 153ms）。',
    'const results = await Promise.all(files.map((f) =>',
    '  import(pathToFileURL(join(DIR, f)).href)',
    '    .then(() => null)',
    '    .catch((e) => [f, String((e && e.message) || e).slice(0, 180)])));',
    'const errors = results.filter(Boolean).sort((a, b) => (a[0] < b[0] ? -1 : 1));',
    'for (const fn of state.cleanups) { try { await fn(); } catch {} }',
    '',
    'console.log("@@COUNT@@" + JSON.stringify({',
    '  count: state.names.length, files: files.length, errors, method }));',
  ].join('\n');
}

/**
 * 数 `dir` 下所有 `*.test.mjs` **真实注册**的测试条数。
 *
 * @returns {{ count: number, files: number, method: string, errors: Array<[string,string]> }
 *          | { error: string, detail?: string }}
 */
export function countRegisteredTests(dir, { timeoutMs = 60000 } = {}) {
  // **目录不存在 ≠ 0 条测试。** 不先分开这两件事，探针会把「我什么都没找到」
  // 报成一个确定的 0，而调用方拿到 0 就静默放行 —— 那正是本缺陷的同一种形态。
  let st = null;
  try { st = statSync(dir); } catch { /* 下面统一报 */ }
  if (!st || !st.isDirectory()) {
    return { error: `测试目录不存在或不是目录：${dir}` };
  }
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probeScript(dir)], {
    encoding: 'utf8',
    timeout: timeoutMs,
    cwd: dirname(dir),
  });
  const out = String(r.stdout || '');
  const line = out.split('\n').find((l) => l.startsWith('@@COUNT@@'));
  if (!line) {
    return {
      error: r.error ? `探针没能跑完：${r.error.message}` : `探针没有回话（exit ${r.status}）`,
      detail: String(r.stderr || '').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300),
    };
  }
  const parsed = JSON.parse(line.slice('@@COUNT@@'.length));
  if (parsed.error) return { error: parsed.error };
  return parsed;
}
