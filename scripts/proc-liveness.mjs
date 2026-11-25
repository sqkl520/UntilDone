#!/usr/bin/env node
/**
 * proc-liveness.mjs —— 「那个守护进程还在不在」的唯一判据（DF-092）。
 *
 * ## 为什么不再 spawn `powershell`
 *
 * 旧实现（`watch.mjs` 的 `probeStartTimeOf`）用 `spawnSync('powershell', …Get-Process…)`
 * 取目标 PID 的启动时刻，再与见证文件里的 `startedAt` 比对。本机实测：
 *
 *   探针耗时      5–24 秒（不是注释里那个 355–390ms 的旧数）
 *   超时上限      5000ms → **每次都在超时前被 kill**
 *   结果          `stdout` 空 → `Date.parse('')` = NaN → 返回 null → 判 `unknown`
 *   附带损害      9 小时累积 22 个 powershell 进程（约 1.7GB），每个 CPU 8–9 秒
 *
 * 根因不是 powershell 慢，是**这台机器上任何 spawn 都慢**：Process Lasso 把
 * node.exe 压在 BelowNormal（`os.getPriority()` = 10），A/B 实测
 * `BelowNormal 13759ms → NORMAL 2804ms`。即使提到 NORMAL，`where /q node`
 * 这种什么都不干的命令仍要 2957ms。所以「缩短超时」「换更轻的命令」都没有出路 ——
 * **整个 spawn 这条路在本机不可用**，而它恰好是判活的唯一路径。
 *
 * ## 替代：命名管道 + nonce
 *
 * 守护进程启动时建一个只属于**这个进程实例**的端点，名字里带随机 nonce：
 *
 *     Windows   \\.\pipe\untildone-<nonce>
 *     POSIX     <stateDir>/liveness-<nonce>.sock   （Unix domain socket）
 *
 * 判活 = 连上端点 **且读到一个 beat**。本机实测（主线程）：
 *
 *     活着的守护进程   连上 + 读到 beat   3–70ms
 *     已经死掉的       连不上            8–11ms
 *
 * ## 为什么「连上」不算活
 *
 * 实测：守护进程的主线程冻结时，**操作系统仍然接受连接**（管道对象由内核持有，
 * 不依赖用户态事件循环）。只判「连上了」会把 DF-023 那类「进程在、实际没在跑」
 * 判成健康 —— 那正是本仓最反对的失效形态。所以必须读到 beat：beat 只能由
 * 守护进程的事件循环写出来，读得到才证明它还能响应。
 *
 * ## 为什么同步读不行（这条是被实测否掉的）
 *
 * `judgeProcess` 原本是同步函数，所以第一版想用 `fs.openSync` + `fs.readSync`
 * 同步读管道。实测（Windows 10 19045 / Node 26）：
 *
 *     服务器会回 beat     open 0.2ms，read 3–7ms           ✓
 *     服务器**不回**      open 3ms，之后 read **永久阻塞**  ✗（加 O_NONBLOCK 无效：
 *                        Node 在 Windows 管道路径上不支持它，实测仍阻塞 20 秒以上）
 *
 * 也就是说，同步读遇到「冻结的守护进程」会**把 `--health` 挂死**，比原来的超时
 * 更坏。因此判活必须异步，`judgeProcess` / `healthCheck` 相应改成返回 Promise。
 * 代价是调用方要 await；换来的是**最坏情况有界**（连不上 8ms，没有 beat 也只会
 * 花掉 `BEAT_TIMEOUT_MS`）。
 *
 * ## PID 复用免疫（DF-028 的核心，不许为绿而削弱）
 *
 * 旧判据靠 `startedAt` 时间容差（±2 秒）识别 PID 复用，那条路有一个**已知边界**：
 * 新进程若在旧进程死后 2 秒内抢到同一个 PID，会被当成「还在」。
 *
 * 现在的判据不再是时间，是**归属**：endpoint 名里带 nonce，nonce 只写在这个进程
 * 自己写下的 `proc.json` 里。PID 被复用 → 新进程用的是**别的 nonce**（它自己随机
 * 生成的），于是旧 endpoint 不存在 → 连不上 → 判 `gone`/`reused`。时间容差从
 * 「判据」降级为「第二道交叉核对」（beat 帧里回带 pid 与 startedAt，对不上仍判 reused）。
 *
 * 两道都必须留：只留 nonce，则「同 nonce 的端点被别的进程监听」无法识别；
 * 只留时间，则回到 2 秒边界。
 *
 * ## 三态
 *
 * `alive` 是 true / false / **null**。null = 判不了。这个模块只负责采证，
 * 不负责下结论（结论在 `watch.mjs` 的 `judgeProcess`），但它给出的 `state`
 * 必须能把「没有端点」「超时」「无权限」「帧解析失败」分开 —— 旧实现把这四件事
 * 一律说成「无权限 / 命令不可用」，而真实原因是超时，这是 DF-091。
 */

import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

/** 协议串。变化时**旧客户端会解析失败并如实报 parse-failed**，不会静默误读。 */
export const LIVENESS_PROTOCOL = 'untildone-live/1';

/** 默认 beat 超时：**毫秒级，不是秒级**。
 *
 *  ## 上限的取法（这是被实测改过一次的数）
 *
 *  第一版取 **800ms**，理由是「一次 tick 的同步段在 300ms 以内，800 是三倍余量」。
 *  **那个理由是错的**，而且错得很具体：本机实测生产守护进程 91 次 tick 的同步段
 *  分布如下（`jobs` + `probe` + `asked` + 增量扫描的耗时之和）：
 *
 *      最大  2001ms   （`probe=1992ms`，一次 L-mid 里扫了两个项目）
 *      次大  1128ms / 1059ms / 880ms
 *      p50    约   15ms
 *
 *  800ms 会把这些**正常的慢 tick** 判成 `unresponsive`（「进程卡住了」）——
 *  实测复现：对真守护进程连探 60 次，其中 1 次落在 `unresponsive`（那一次正好撞上慢 tick）。
 *  那是**假告警**，而本仓对假告警的判词是「它会驯化人忽略所有告警」。
 *
 *  所以取 **3000ms**：实测最大值 2001ms × 1.5 ≈ 3000。它不是「拍一个更宽的数」——
 *  它有一个可复核的下界（必须 > 2001）和一个可说明的余量（1.5 倍给更慢的机器）。
 *
 *  ## 代价（如实说）
 *
 *  它同时是**最坏情况的全部代价**：端点存在但无人应答时，探针只花这 3000ms 就返回，
 *  不会像同步读那样挂死。而 3000ms 仍远在 AC-1 的 10 秒上限之内。
 *
 *  ## 为什么不再往上取
 *
 *  再大就会让「真的冻住了」这件事越来越慢被发现，而那是这一层最该快的结论。
 *  真正冻住的进程连一个 tick 都写不完，3 秒足够读出差别。 */
export const BEAT_TIMEOUT_MS = 3000;

/** 生成 nonce：12 字节随机 → 24 个十六进制字符。
 *
 *  为什么不用 pid / 时间戳：那两样都可预测，而 endpoint 名必须在**跨进程、跨重启**
 *  的意义上唯一 —— 否则「另一个进程恰好设了同名端点」就能伪造活信号。
 *  24 个十六进制字符 = 96 bit，碰撞概率可以忽略。 */
export function makeNonce(random = randomBytes) {
  return random(12).toString('hex');
}

/** endpoint 名字。**名字里必须含 nonce** —— 这是 PID 复用免疫的来源。
 *
 *  @param {{nonce:string, stateDir?:string, platform?:NodeJS.Platform}} p */
export function livenessEndpoint({ nonce, stateDir = null, platform = process.platform } = {}) {
  if (!nonce || typeof nonce !== 'string') throw new TypeError('livenessEndpoint: 必须给 nonce');
  if (platform === 'win32') return `\\\\.\\pipe\\untildone-${nonce}`;
  // POSIX 用 Unix domain socket。**已知限制**：`sun_path` 在 Linux 上是 108 字节、
  // macOS 104 字节，超长会让 `listen()` 直接 ENAMETOOLONG。这里不截断、不改路径
  // （截断会让两个实例撞名，正是要防的那类事），而是让启动失败如实上报 ——
  // 调用方会把「没有判活端点」写进 proc.json，`--health` 于是说「判不了」而不是
  // 编一个「健康」。宁可降级也不撒谎。
  if (!stateDir) throw new TypeError('livenessEndpoint: POSIX 必须给 stateDir');
  return join(String(stateDir), `liveness-${nonce}.sock`);
}

/** beat 帧：`<协议> nonce=<hex> pid=<n> started=<iso> beats=<n>`。
 *
 *  为什么要回带 pid 与 startedAt：nonce 解决「这是不是那个实例的端点」，
 *  pid/startedAt 解决「监听者是不是它」—— 两者都不够，合起来才够。
 *  用 `\n` 结尾，客户端读到换行即可结束，不必等 FIN（少一次往返）。 */
export function beatFrame({ nonce, pid, startedAt, beats = 0 }) {
  return `${LIVENESS_PROTOCOL} nonce=${nonce} pid=${pid} started=${startedAt} beats=${beats}\n`;
}

/** 解析 beat 帧。**解析不出来返回 null，不抛** —— 调用方要把它报成 `parse-failed`。 */
export function parseBeatFrame(text) {
  const line = String(text || '').split('\n').find((l) => l.trim());
  if (!line) return null;
  const m = line.trim().match(
    /^(\S+) nonce=([0-9a-fA-F]+) pid=(\d+) started=(\S+) beats=(\d+)$/);
  if (!m) return null;
  if (m[1] !== LIVENESS_PROTOCOL) return null;
  const startedMs = Date.parse(m[4]);
  if (!Number.isFinite(startedMs)) return null;
  return {
    protocol: m[1],
    nonce: m[2],
    pid: Number(m[3]),
    startedAt: m[4],
    startedMs,
    beats: Number(m[5]),
  };
}

/** 启动监听端点。返回 `{ ok, endpoint, nonce, close() }`。
 *
 *  **失败不抛**：判活端点起不来不该杀死守护进程（监控坏了的第一反应不该是
 *  「干脆不监控」，与 `checkStateIntegrity` 同一条理由）。调用方拿 `ok:false`
 *  去日志里大喊，并让 proc.json 写成「没有端点」—— 于是 `--health` 说「判不了」，
 *  而不是编一个健康。 */
export async function startLivenessServer({ endpoint, nonce, pid, startedAt, logger = null } = {}) {
  if (!endpoint) throw new TypeError('startLivenessServer: 必须给 endpoint');
  let beats = 0;
  const server = net.createServer((sock) => {
    // 连接处理器必须**只做一件事**：回一帧。它跑在事件循环上，任何多余的工作
    // 都会直接推迟 beat，进而把「守护进程在忙」变成「探针超时」。
    beats += 1;
    sock.on('error', () => { /* 对端提前断开不是错误 */ });
    try {
      sock.end(beatFrame({ nonce, pid, startedAt, beats }));
    } catch { /* 写失败 = 对端已断；下一帧还有机会 */ }
  });
  server.on('error', () => { /* listen 阶段的错误由下面的 once 捕获 */ });
  const ok = await new Promise((resolve) => {
    const onErr = (e) => resolve({ ok: false, error: `${e.code || 'ERROR'}: ${e.message}` });
    server.once('error', onErr);
    try {
      server.listen(endpoint, () => {
        server.removeListener('error', onErr);
        resolve({ ok: true });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message) });
    }
  });
  if (!ok.ok) {
    if (logger && typeof logger.error === 'function') {
      logger.error(`liveness-listen-failed ${endpoint}: ${ok.error}（判活端点起不来，`
        + '--health 会因此报「判不了」——这是如实降级，不是健康）');
    }
    return { ok: false, endpoint, nonce, error: ok.error, close: async () => {} };
  }
  return {
    ok: true,
    endpoint,
    nonce,
    async close() {
      await new Promise((r) => { try { server.close(() => r()); } catch { r(); } });
      // POSIX 的 socket 文件不会随进程退出自动消失（Windows 管道会），
      // 残留文件会让「端点还在」永远成立 —— 那会把 PID 复用免疫退化成「永远活着」。
      if (process.platform !== 'win32') {
        try { unlinkSync(endpoint); } catch { /* 已经没了 */ }
      }
    },
  };
}

/** `state` 的枚举。**它必须比 `alive` 更细** —— 四种失败原因的处置不同。 */
export const PROBE_STATES = Object.freeze([
  'beat',           // 连上且读到了帧
  'not-found',      // 端点不存在（ENOENT / 没有监听者）→ 进程已退出
  'refused',        // 端点存在但拒绝连接（ECONNREFUSED，POSIX 残留 socket 文件）
  'timeout',        // 连上了但超时内没有 beat → 进程可能在，但事件循环无响应
  'eperm',          // 无权限连接（EACCES / EPERM）
  'parse-failed',   // 读到了东西，但它不是本协议的 beat 帧
  'closed',         // 对端在写出任何东西之前就关了
  'error',          // 其它错误（带 code）
]);

/** 每种 probe 状态在 `judgeProcess` 里落成什么结论。**这张表就是 DF-091 的答案**：
 *  旧实现把「超时 / 命令不存在 / 无权限 / 解析失败」四种原因一律说成
 *  「无权限 / 命令不可用」，而真实原因 100% 是超时 —— 用户照着那句话去查权限，
 *  永远查不到东西。 */
export const PROBE_OUTCOME = Object.freeze({
  beat: { alive: 'frame' },                 // 交给帧比对决定
  'not-found': { alive: false, verdict: 'gone' },
  refused: { alive: false, verdict: 'gone' },
  closed: { alive: false, verdict: 'gone' },
  timeout: { alive: null, verdict: 'unresponsive' },
  eperm: { alive: null, verdict: 'unknown' },
  'parse-failed': { alive: null, verdict: 'unknown' },
  error: { alive: null, verdict: 'unknown' },
});

/** 把 `net` 的错误码映射成上面那组 `state`。
 *
 *  这是 DF-091 的落点：旧实现把所有失败都写成「无权限 / 命令不可用」，
 *  而真实原因 100% 是超时。现在每种原因有自己的名字，文案由调用方按名字生成。 */
export function stateOfErrorCode(code) {
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'not-found';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'EACCES' || code === 'EPERM') return 'eperm';
  if (code === 'ETIMEDOUT') return 'timeout';
  return 'error';
}

/** 采证：连一次端点，最多等 `timeoutMs`。
 *
 *  返回 `{ state, ms, detail?, frame?, raw? }`。**永不抛、永不 reject**：
 *  这是一个探针，它失败的信息本身就是结论的一部分。
 *
 *  ## 为什么用一个总超时，而不是 connect / read 各一个
 *
 *  两段各自设超时会让最坏情况变成「两倍」。判活的成本必须是一个可预先声明的数
 *  （`BEAT_TIMEOUT_MS`），否则「--health 有界」这句话又变成自欺。 */
export function probeLiveness({ endpoint, nonce, timeoutMs = BEAT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    let buf = '';
    let timer = null;
    let sock = null;

    const finish = (state, extra = {}) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (sock) sock.destroy(); } catch { /* 已断 */ }
      resolve({ state, ms: Date.now() - t0, endpoint, nonce, ...extra });
    };

    timer = setTimeout(() => {
      // 走到这里说明「连得上但没人应答」。这条分支是同步读做不到的那一条。
      finish('timeout', { detail: `${timeoutMs}ms 内没有读到 beat` });
    }, timeoutMs);
    // 超时计时器不该拖住进程退出（--health 是一次性命令）。
    if (typeof timer.unref === 'function') timer.unref();

    try {
      sock = net.connect({ path: endpoint });
    } catch (e) {
      finish(stateOfErrorCode(e && e.code), { detail: String(e && e.message) });
      return;
    }
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.includes('\n')) {
        const frame = parseBeatFrame(buf);
        if (frame) finish('beat', { frame, raw: buf.trim() });
        else finish('parse-failed', { detail: `不是本协议的 beat 帧：${JSON.stringify(buf.slice(0, 120))}` });
      }
    });
    sock.on('error', (e) => {
      finish(stateOfErrorCode(e && e.code), { detail: `${e && e.code}: ${e && e.message}` });
    });
    sock.on('end', () => {
      // 对端关了但我们一个字节都没读到。
      if (!buf) finish('closed', { detail: '端点接受连接后未写出任何字节' });
      else finish('parse-failed', { detail: `帧不完整：${JSON.stringify(buf.slice(0, 120))}` });
    });
  });
}
