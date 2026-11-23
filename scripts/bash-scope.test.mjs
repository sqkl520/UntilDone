#!/usr/bin/env node
/**
 * bash-scope.test.mjs — 只读角色的 `Bash` 出口（`bashScope: read-only`）的回归测试。
 *
 * ## 它守的是什么
 *
 * `checkAgents()` 的原有规则是「`readonly: true` 的角色不得拥有 `Bash`」，
 * 理由是 `Bash` 能写盘，而 `Write` 至少可以从路径上限制。
 *
 * 2026-11-23 加 `oversight-verifier` 时撞上了这条规则：核验类角色的职责**就是**
 * 跑只读命令去核事实（`grep` / `wc` / `node --test`），没有 `Bash` 它物理上做不了，
 * 只能退化成「读一遍源码觉得它对」—— 那是判断，不是核验。
 *
 * ## 修法是收紧不是放松
 *
 *   修前：`readonly + Bash` → 一律违规。
 *   修后：`readonly + Bash` 要求 **① frontmatter 写 `bashScope: read-only`**
 *        **且 ② 正文有 `## 允许的命令` 一节**。两条缺一条照样红。
 *
 * 这一份测试逐个钉住三个方向：
 *   · 只有 Bash、没有声明 → 红（规则没被放松）；
 *   · 声明了但没有命令清单 → 红（声明本身不可核对）；
 *   · 两条都齐 → 放行（否则修法等于「禁止」，而禁止会让 verifier 无法存在）。
 *
 * ## 为什么必须跑真身
 *
 * 判据的对象是 `.claude/agents/*.md` 的字节与硬门的实现。用 `bashScopeOf()` 单测
 * 只能证明那个函数对，证明不了**硬门用了它** —— 而「函数对、没人调用」正是本仓
 * 反复出现的形态（DF-079 / DF-080）。所以这里 spawn 子进程跑真门。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { bashScopeOf, BASH_SCOPES } from './roles.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const GATE = join(REPO, 'scripts', 'check-structure.mjs');

/** 造一个只含「一个角色定义」的最小项目，跑硬门，返回输出。
 *
 *  最小项目 = `.claude/agents/<name>.md` + `README.md` + `.untildone/checks.json`。
 *  缺 README 会让 `checkCapabilityDisclosure` 报红（与本用例无关）；
 *  缺 `.untildone/` 会让 `projectRoot()` 走错分支。
 *
 *  **关掉 `testCount` / `importable`**：它们各起一个子进程 import 全部测试文件
 *  （45 秒超时），与本用例要验的判据无关。门会在输出里逐条打印「已关闭」。
 */
function runGateWith(agentMd, { name = 'oversight-probe-x' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ow-bashscope-'));
  try {
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    mkdirSync(join(dir, '.untildone'), { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# 测试项目\n不能自动接力。\n', 'utf8');
    writeFileSync(join(dir, '.untildone', 'checks.json'), JSON.stringify({
      disabledChecks: ['testCount', 'importable'],
    }), 'utf8');
    writeFileSync(join(dir, '.claude', 'agents', `${name}.md`), agentMd, 'utf8');

    const r = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8', timeout: 240000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    assert.ok(r.status !== null, `硬门没有正常退出（超时或被杀）—— 环境性失败：\n${out}`);
    assert.ok(out.length > 0, '硬门没有任何输出 —— 探针坏了');
    return { status: r.status, out };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** 一份只读角色定义。`extraFrontmatter` 插在收尾 `---` 之前；`body` 是正文。 */
function roleMd({ tools = 'Read, Grep, Bash', readonly = true, extraFrontmatter = '', body = '正文。只允许写报告。' } = {}) {
  return [
    '---',
    'name: oversight-probe-x',
    'description: 测试用的只读角色定义，正文无所谓，只要 frontmatter 完整。',
    `tools: ${tools}`,
    `readonly: ${readonly}`,
    ...(extraFrontmatter ? [extraFrontmatter] : []),
    '---',
    '',
    body,
    '',
  ].join('\n');
}

const CMD_SECTION = [
  '',
  '## 允许的命令',
  '',
  '```bash',
  'grep -rn / rg',
  'wc -l',
  'node scripts/<x>.mjs',
  '```',
].join('\n');

// ── 单元层：完全是数据的一小步 ────────────────────────────────────────

test('bashScopeOf 只认 `read-only`：拼错的值一律当没写（不许静默变绿）', () => {
  assert.deepEqual([...BASH_SCOPES], ['read-only']);
  assert.equal(bashScopeOf({ bashScope: 'read-only' }), 'read-only');
  assert.equal(bashScopeOf({ bashScope: ' Read-Only ' }), 'read-only', '大小写与空白应当归一');
  for (const bad of ['readonly', 'read-only-bash', 'r', 'yes', '', undefined, null]) {
    assert.equal(bashScopeOf({ bashScope: bad }), null, `"${bad}" 被当成了合法值 —— 拼错不能静默生效`);
  }
});

// ── 硬门层：三个方向 ──────────────────────────────────────────────────

test('硬门：只读 + Bash 但**没写** bashScope → 红（规则没被放松）', () => {
  const { status, out } = runGateWith(roleMd());
  assert.notEqual(status, 0, `没写 bashScope 却放行了：\n${out}`);
  assert.match(out, /bashScope: read-only/, `报错没教人怎么改：\n${out}`);
});

test('硬门：写了 bashScope 但正文没有「## 允许的命令」→ 红（声明不可核对）', () => {
  // 这是修法里最关键的一条：`bashScope` 本身是一句自我声明。
  // 没有命令清单的话，「只读」与「不受限的 Bash」在文件外观上完全同形。
  const { status, out } = runGateWith(roleMd({ extraFrontmatter: 'bashScope: read-only' }));
  assert.notEqual(status, 0, `没有命令清单却放行了：\n${out}`);
  assert.match(out, /## 允许的命令/, `报错没点名缺哪一节：\n${out}`);
});

test('硬门：bashScope + 命令清单都齐 → 放行（否则修法等于「禁止」）', () => {
  // 没有这一条，把规则写成「只读角色一律不许有 Bash」也能让上面两条变绿 ——
  // 而那会让 `oversight-verifier` 无法存在。
  const { out } = runGateWith(roleMd({
    extraFrontmatter: 'bashScope: read-only',
    body: `正文。只允许写报告。\n${CMD_SECTION}`,
  }));
  assert.doesNotMatch(out, /bashScope/, `两条都齐了却仍报 bashScope：\n${out}`);
});

test('硬门：只读 + Edit（无 Bash）→ 仍然红，bashScope 不覆盖 Edit', () => {
  // `bashScope` 的名字就是它的范围：只覆盖 Bash。给它加 Edit 仍然走原判据。
  const { status, out } = runGateWith(roleMd({
    tools: 'Read, Grep, Edit',
    extraFrontmatter: 'bashScope: read-only',
    body: `正文。只允许写报告。\n${CMD_SECTION}`,
  }));
  assert.notEqual(status, 0, `只读 + Edit 被 bashScope 放行了：\n${out}`);
  assert.match(out, /不得拥有 Edit|拥有写工具/, `报错不看 Edit：\n${out}`);
});

test('硬门：非只读角色带 Bash 不受影响（bashScope 只约束只读角色）', () => {
  const { out } = runGateWith(roleMd({ tools: 'Read, Write, Edit, Bash, Glob, Grep', readonly: false }));
  assert.doesNotMatch(out, /bashScope/, `非只读角色被 bashScope 规则误伤：\n${out}`);
});
