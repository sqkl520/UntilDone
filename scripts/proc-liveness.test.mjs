#!/usr/bin/env node
/**
 * proc-liveness.test.mjs —— 判活端点这一层的回归测试（DF-092）。
 *
 * ## 这一份为什么必须存在
 *
 * `watch.test.mjs` 里那 12 条 DF-028 用例**注入了假 `probe`**（AC-4 的要求：
 * 把探针改坏它们仍须全绿）。那是正确的 —— 它们验的是分支逻辑。
 * 但它留下一个洞：**探针实现本身没有被任何用例走过**。
 *
 * 这一份补那个洞，且只测「端点这一层」：
 *   · 起了监听之后，真连、真读到帧；
 *   · 帧里的 nonce / pid / started / beats 都是真的；
 *   · 端点关掉之后，真连报 `not-found`（不是「连上就算活着」）；
 *   · 端点**存在但不应答**时报 `timeout`（这条是同步读做不到的那个分支）。
 *
 * 每一条都用真端点、真 socket，**不注入任何东西**。成本实测：整份 < 1 秒
 * （起监听约 10ms，三次探测各 1–20ms，超时那条按注入的 timeoutsMs 走）。
 *
 * ## 为什么超时那条要单独起一个「不应答」的服务器
 *
 * 生产里「不应答」的形态是**守护进程主循环冻住**（DF-023 / DF-028 的现场）。
 * 真造那个形态要把一个进程冻住 —— 冻住之后它连测试的断言也执行不了。
 * 所以这里用一个**接受了连接但永不写**的裸 `net` 服务器：它精确复现
 * 「OS 接受连接、用户态没人应答」这一个可观察事实，而这正是探针要区分的那件事。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  BEAT_TIMEOUT_MS, LIVENESS_PROTOCOL, PROBE_STATES, PROBE_OUTCOME,
  makeNonce, livenessEndpoint, beatFrame, parseBeatFrame,
  startLivenessServer, probeLiveness, stateOfErrorCode,
} from './proc-liveness.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'ow-live-test-'));

/** 起一个真端点并用完就关。`fn` 拿到 `{ endpoint, nonce, pid, startedAt }`。 */
async function withServer(fn, { startedAt = new Date(Date.now() - 5000).toISOString() } = {}) {
  const nonce = makeNonce();
  const endpoint = livenessEndpoint({ nonce, stateDir: tmp(), platform: process.platform });
  const srv = await startLivenessServer({ endpoint, nonce, pid: process.pid, startedAt });
  assert.equal(srv.ok, true, `判活端点没起来：${srv.error}`);
  try {
    return await fn({ endpoint, nonce, pid: process.pid, startedAt, srv });
  } finally {
    await srv.close();
  }
}

// ── 纯判据：名字与帧 ──────────────────────────────────────────────

test('makeNonce：24 个十六进制字符，且两次不同（endpoint 名必须跨进程唯一）', () => {
  const a = makeNonce();
  const b = makeNonce();
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.match(b, /^[0-9a-f]{24}$/);
  assert.notEqual(a, b, '两个 nonce 相同意味着两个进程会抢同一个端点名');
});

test('livenessEndpoint：Windows 是命名管道，POSIX 是 stateDir 下的 socket 文件', () => {
  assert.equal(livenessEndpoint({ nonce: 'abc', platform: 'win32' }),
    '\\\\.\\pipe\\untildone-abc');
  assert.equal(livenessEndpoint({ nonce: 'abc', stateDir: '/var/tmp/s', platform: 'linux' }),
    join('/var/tmp/s', 'liveness-abc.sock'));
  // **nonce 必须出现在名字里** —— 这是 PID 复用免疫的唯一来源。
  // 一个不含 nonce 的固定名字，会让「新进程用了旧 PID」照样命中旧端点。
  assert.match(livenessEndpoint({ nonce: 'deadbeef', platform: 'win32' }), /deadbeef/);
});

test('livenessEndpoint：没有 nonce / POSIX 没有 stateDir 都必须抛，不许猜一个默认值', () => {
  assert.throws(() => livenessEndpoint({}), /nonce/);
  assert.throws(() => livenessEndpoint({ nonce: 'a', platform: 'linux' }), /stateDir/);
});

test('parseBeatFrame：读得懂自己的帧，读不懂别的返回 null（不抛）', () => {
  const f = beatFrame({ nonce: 'a'.repeat(24), pid: 42, startedAt: '2026-11-24T00:00:00.000Z', beats: 7 });
  assert.match(f, /\n$/, '帧必须以换行结尾：客户端读到换行就结束，不必等 FIN');
  const p = parseBeatFrame(f);
  assert.equal(p.protocol, LIVENESS_PROTOCOL);
  assert.equal(p.nonce, 'a'.repeat(24));
  assert.equal(p.pid, 42);
  assert.equal(p.beats, 7);
  assert.equal(p.startedMs, Date.parse('2026-11-24T00:00:00.000Z'));

  // 四种「读不懂」都必须返回 null 而不是抛：调用方要把它报成 parse-failed，
  // 而不是让异常冒到 --health 外面。
  for (const bad of ['', 'garbage', 'untildone-live/2 nonce=aa pid=1 started=2026-11-24T00:00:00Z beats=1',
    `${LIVENESS_PROTOCOL} nonce=aa pid=x started=2026-11-24T00:00:00Z beats=1`,
    `${LIVENESS_PROTOCOL} nonce=aa pid=1 started=not-a-date beats=1`]) {
    assert.equal(parseBeatFrame(bad), null, `这段不该被解析成帧：${JSON.stringify(bad)}`);
  }
  // 协议号不同必须是**读不懂**，不是「勉强能用」—— 版本不一致时误读帧，
  // 会让新老代码互相把对方的话当成自己的结论。
  assert.equal(parseBeatFrame(`${LIVENESS_PROTOCOL} extra nonce=aa pid=1 started=2026-11-24T00:00:00Z beats=1`), null);
});

test('stateOfErrorCode：四种失败原因各有各的名字，未知码落回 error（不是 not-found）', () => {
  assert.equal(stateOfErrorCode('ENOENT'), 'not-found');
  assert.equal(stateOfErrorCode('ECONNREFUSED'), 'refused');
  assert.equal(stateOfErrorCode('EACCES'), 'eperm');
  assert.equal(stateOfErrorCode('EPERM'), 'eperm');
  assert.equal(stateOfErrorCode('ETIMEDOUT'), 'timeout');
  // **「不认识」不能等于「进程没了」**：那会把「判不了」说成「已经死了」，
  // 于是处置从「再看看」变成「重启」，而重启一个还活着的进程会丢现场。
  assert.equal(stateOfErrorCode('EZOMBIE'), 'error');
  assert.equal(stateOfErrorCode(undefined), 'error');
});

test('PROBE_STATES 与 PROBE_OUTCOME 必须一一对应（新增一个状态而忘了给结论 = 静默落进默认档）', () => {
  assert.deepEqual([...PROBE_STATES].sort(), Object.keys(PROBE_OUTCOME).sort(),
    '两张表的键集必须相同 —— 否则新状态会静默落进 judgeProcess 的兜底分支');
  // `beat` 是唯一不能直接给结论的那一个：它的结论取决于帧里写了什么。
  assert.equal(PROBE_OUTCOME.beat.alive, 'frame');
  assert.equal(PROBE_OUTCOME['not-found'].alive, false);
  assert.equal(PROBE_OUTCOME.timeout.alive, null, '读不到 beat 是「不知道」，不是「死了」');
});

// ── 真端点：连得上、读得到 ─────────────────────────────────────────

test('probeLiveness：真端点必须读到 beat，且帧里的 nonce / pid 都是真的', async () => {
  await withServer(async ({ endpoint, nonce }) => {
    const r = await probeLiveness({ endpoint, nonce, timeoutMs: 5000 });
    assert.equal(r.state, 'beat', `没读到 beat：${r.state} ${r.detail || ''}`);
    assert.equal(r.frame.nonce, nonce);
    assert.equal(r.frame.pid, process.pid);
    assert.ok(r.frame.beats >= 1);
    assert.ok(r.ms < 5000, `探针花了 ${r.ms}ms`);
  });
});

test('probeLiveness：连续探测的 beats 必须递增 —— 证明每个连接都被真的处理了', async () => {
  await withServer(async ({ endpoint, nonce }) => {
    const a = await probeLiveness({ endpoint, nonce, timeoutMs: 5000 });
    const b = await probeLiveness({ endpoint, nonce, timeoutMs: 5000 });
    assert.equal(a.state, 'beat');
    assert.equal(b.state, 'beat');
    assert.ok(b.frame.beats > a.frame.beats,
      `第二次连接没被处理（beats ${a.frame.beats} → ${b.frame.beats}）—— `
      + '那说明监听器的连接处理没有真的跑');
  });
});

test('probeLiveness：端点关掉之后必须报 not-found（不许「连上就算活着」）', async () => {
  const nonce = makeNonce();
  const endpoint = livenessEndpoint({ nonce, stateDir: tmp(), platform: process.platform });
  const srv = await startLivenessServer({ endpoint, nonce, pid: process.pid, startedAt: new Date().toISOString() });
  assert.equal(srv.ok, true);
  await srv.close();
  const r = await probeLiveness({ endpoint, nonce, timeoutMs: 5000 });
  assert.notEqual(r.state, 'beat', '端点已经关了');
  assert.equal(r.state, 'not-found', `关掉的端点必须报 not-found，实际 ${r.state}（${r.detail || ''}）`);
  // 它必须**快**：端点不存在是「立刻知道」的情况，不该等满超时。
  // 这条钉住「超时参数不是万能兜底」——若 not-found 也要等到超时，
  // 那是把「进程已经没了」这个最常见的结论拖成最慢的那一个。
  assert.ok(r.ms < BEAT_TIMEOUT_MS, `not-found 花了 ${r.ms}ms，不该等满 ${BEAT_TIMEOUT_MS}ms`);
});

test('probeLiveness：端点接受连接但永不写出 → timeout（这条是同步读做不到的分支）', async () => {
  // 裸服务器：只 accept，不写。它精确复现「OS 接受连接、用户态没人应答」。
  const nonce = makeNonce();
  const endpoint = livenessEndpoint({ nonce, stateDir: tmp(), platform: process.platform });
  const silent = net.createServer(() => { /* 故意什么都不做 */ });
  await new Promise((r) => silent.listen(endpoint, r));
  try {
    const t0 = Date.now();
    const r = await probeLiveness({ endpoint, nonce, timeoutMs: 300 });
    const ms = Date.now() - t0;
    assert.equal(r.state, 'timeout', `应当是超时那一档，实际 ${r.state}`);
    // **有界**：它必须按注入的超时返回，而不是挂住。
    // 实测后果（DF-092）：同步 `readSync` 在这个场景里**永久阻塞**，
    // 会把 `--health` 整个挂死 —— 比原来的 5 秒超时更坏。
    assert.ok(ms >= 250 && ms < 3000, `超时判据没有按 timeoutMs 生效：${ms}ms（注入 300ms）`);
    assert.equal(r.frame, undefined, '超时不该带出帧');
  } finally {
    await new Promise((r) => silent.close(() => r()));
    // POSIX 的 socket 文件不会随 close 消失；本用例自己清掉，免得污染下一条。
    if (process.platform !== 'win32') { try { rmSync(endpoint, { force: true }); } catch { /* 已无 */ } }
  }
});

test('startLivenessServer：同一个端点名起两次必须报 ok:false（不是静默抢）', async () => {
  const nonce = makeNonce();
  const endpoint = livenessEndpoint({ nonce, stateDir: tmp(), platform: process.platform });
  const a = await startLivenessServer({ endpoint, nonce, pid: process.pid, startedAt: new Date().toISOString() });
  assert.equal(a.ok, true, `第一个没起来：${a.error}`);
  try {
    const b = await startLivenessServer({ endpoint, nonce, pid: process.pid, startedAt: new Date().toISOString() });
    // **不许抛**：端点上不了不是致命错误，调用方要靠这个返回值去如实降级。
    assert.equal(b.ok, false, '同一个端点名不该被第二个实例抢走');
    assert.ok(b.error, '必须给出原因，否则日志里只剩「起不来」');
  } finally { await a.close(); }
});

test('startLivenessServer：close 之后端点必须真的不可连（残留监听会让「已退出」永远判成「卡住」）', async () => {
  const nonce = makeNonce();
  const stateDir = tmp();
  const endpoint = livenessEndpoint({ nonce, stateDir, platform: process.platform });
  const srv = await startLivenessServer({ endpoint, nonce, pid: process.pid, startedAt: new Date().toISOString() });
  assert.equal(srv.ok, true);
  await srv.close();
  // 再连一次：必须连不上。若 close 只是关掉了「写」而没有放开监听，
  // 探针会连上然后等满超时 → 报 timeout（「进程卡住」），而真相是「已经退出」。
  const r = await probeLiveness({ endpoint, nonce, timeoutMs: 300 });
  assert.notEqual(r.state, 'timeout', 'close 之后还能连上 —— 那会把「已退出」误报成「卡住」');
  assert.notEqual(r.state, 'beat');
});

// ── 组合：端点这一层与 judgeProcess 的接口约定 ────────────────────

test('probeLiveness 的返回值形状必须够 judgeProcess 用（state 必在，beat 时必带 frame）', async () => {
  await withServer(async ({ endpoint, nonce }) => {
    const ok = await probeLiveness({ endpoint, nonce, timeoutMs: 5000 });
    assert.equal(typeof ok.state, 'string');
    assert.ok(PROBE_STATES.includes(ok.state), `state 不在枚举里：${ok.state}`);
    assert.equal(typeof ok.ms, 'number');
    if (ok.state === 'beat') {
      // judgeProcess 的三道交叉核对读的就是这四个字段。少一个就会静默走 reused。
      for (const k of ['nonce', 'pid', 'startedAt', 'startedMs', 'beats']) {
        assert.ok(ok.frame && k in ok.frame, `beat 帧缺 ${k} —— judgeProcess 的三道核对会用不上它`);
      }
    }
  });
});

test('探针默认超时必须是毫秒级（AC-1 的 10 秒上限不允许它是秒级）', () => {
  assert.ok(Number.isInteger(BEAT_TIMEOUT_MS), 'BEAT_TIMEOUT_MS 必须是整数毫秒');
  assert.ok(BEAT_TIMEOUT_MS > 0 && BEAT_TIMEOUT_MS < 5000,
    `默认超时 ${BEAT_TIMEOUT_MS}ms 太长了：它是最坏情况的全部代价，`
    + '设成秒级会让「--health 有界」重新变成一句空话');
});
