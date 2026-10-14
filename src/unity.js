// Unity 모드: 게임에 들어 있는 gameprobe 패키지(GameProbeServer)와 TCP로 대화한다.
// 게임은 프레임 사이에서 엔진 안에서 멈춰 있고, 요청한 만큼만 고정 dt로 진행한다.
// 경로 읽기는 Unity가, until/watch/정책 같은 JS 로직은 여기(Node)가 맡는다. 그래서 웹 모드와 같은 도구가 그대로 통한다.
//   watch/until 은 경로 하나("Player.transform.position.y") 또는 $("경로")를 쓰는 JS 식
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { Session } from './session.js';
import { Helper } from './native.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

// 식에서 읽어야 할 경로를 뽑는다: $("a.b") / $('a.b') 리터럴, 아니면 식 전체가 경로
const PATH_CALL = /\$\(\s*(["'`])((?:(?!\1).)+)\1\s*\)/g;
export function pathsIn(expr) {
  if (!expr) return [];
  const found = [...expr.matchAll(PATH_CALL)].map((m) => m[2]);
  if (found.length) return found;
  return isPlainPath(expr) ? [expr.trim()] : [];
}
const isPlainPath = (e) => !e.includes('$(') && /^\s*[#$\[]?[\w\[\] .#$-]*\s*$/.test(e) && !/[<>=!&|+*/%?:]/.test(e);

function compileExpr(expr) {
  if (isPlainPath(expr)) { const p = expr.trim(); return (get) => get(p); }
  const fn = new Function('$', `return (${expr});`);
  return (get) => fn(get);
}

// 웹 모드 shim 의 summarize 와 같은 규칙
function summarize(samples, maxSamples = 12) {
  const nums = samples.filter(([, v]) => typeof v === 'number');
  if (nums.length === samples.length && nums.length) {
    const vs = nums.map(([, v]) => v);
    const min = Math.min(...vs), max = Math.max(...vs);
    if (min === max) return { constant: min };
    const pick = [];
    const k = Math.max(1, Math.ceil(nums.length / maxSamples));
    for (let i = 0; i < nums.length; i += k) pick.push(nums[i]);
    if (pick[pick.length - 1] !== nums[nums.length - 1]) pick.push(nums[nums.length - 1]);
    return { first: vs[0], last: vs[vs.length - 1], min, max, samples: pick };
  }
  const changes = [];
  let prev;
  for (const [f, v] of samples) { const s = JSON.stringify(v); if (s !== prev) { changes.push([f, v]); prev = s; } }
  return changes.length > 20 ? { changes: changes.slice(0, 10).concat([['...', `${changes.length - 20} more`]], changes.slice(-10)) } : { changes };
}

function num(x, d) {
  if (x === undefined || x === null) return d;
  if (typeof x === 'number') return x;
  const s = String(x).trim();
  if (!/^[\d\s.+\-*/()eE]+$/.test(s)) throw new Error(`not a number: ${s}`);
  return Function(`return (${s});`)();
}

export class UnitySession {
  constructor() {
    this.sock = null; this.child = null; this.logs = [];
    this.held = { keys: new Set(), buttons: new Set() };
    this.taps = { keys: new Set(), buttons: new Set() };
    this.pendingLook = null; this.pointer = null;
  }

  // ---------- 연결 ----------
  async connect(port, timeoutMs) {
    const t0 = Date.now();
    let lastErr;
    while (Date.now() - t0 < timeoutMs) {
      if (this.child && this.child.exitCode !== null) throw new Error(`game exited (code ${this.child.exitCode}) before gameprobe answered`);
      try {
        await new Promise((res, rej) => {
          const s = net.connect(port, '127.0.0.1', () => { this.sock = s; res(); });
          s.once('error', rej);
        });
        break;
      } catch (e) { lastErr = e; await sleep(300); }
    }
    if (!this.sock) throw Object.assign(new Error(`no gameprobe server on port ${port} (${lastErr?.code || 'timeout'})`), { noPlugin: true });
    this.sock.setNoDelay(true);
    this.waiting = new Map(); this.nextId = 1;
    readline.createInterface({ input: this.sock }).on('line', (line) => {
      const m = JSON.parse(line);
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      m.error ? w.reject(new Error(m.error)) : w.resolve(m);
    });
    this.sock.on('close', () => { for (const w of this.waiting.values()) w.reject(new Error('game connection closed')); this.waiting.clear(); this.sock = null; });
  }

  call(cmd, args = {}, timeoutMs = 120000) {
    if (!this.sock) return Promise.reject(new Error('not connected to the game'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`game did not answer ${cmd} in ${timeoutMs} ms`)); }, timeoutMs);
      this.waiting.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.sock.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  async open(opts = {}) {
    const { exe, args = [], unity, seed = 1, timeoutMs = 30000, keepRunning = false, warmupFrames = 2, width = 1280, height = 720 } = opts;
    await this.close();
    this.lastOpen = opts; this.keepRunning = keepRunning; this.logs = [];
    this.held = { keys: new Set(), buttons: new Set() }; this.taps = { keys: new Set(), buttons: new Set() };
    this.pendingLook = null; this.pointer = null;
    let port;
    if (unity) port = Number(String(unity).split(':').pop());
    else {
      port = await freePort();
      this.child = spawn(exe, ['-gameprobe-port', String(port), '-gameprobe-seed', String(seed),
        '-screen-fullscreen', '0', '-screen-width', String(width), '-screen-height', String(height), ...args],
        { cwd: path.dirname(exe), stdio: 'ignore' });
      const child = this.child;
      child.on('exit', (code) => { if (!child.closing) this.logs.push(`game process exited with code ${code}`); });
    }
    await this.connect(port, timeoutMs);
    this.info = await this.call('hello');
    if (warmupFrames) await this.call('step', { frames: warmupFrames, input: { keys: [], buttons: [], look: { x: 0, y: 0 } } });
    return {
      mode: 'unity', unity: this.info.unity, product: this.info.product, scene: this.info.scene, screen: this.info.screen,
      inputSystem: this.info.inputSystem, seed: this.info.seed, paused: true,
      notes: [
        'Unity mode: the game is held inside the engine between your calls and advances exactly N frames per step at a fixed dt.',
        'Read anything by path: "Player.transform.position.y", "Player.PlayerController.grounded", "#GameManager.score", "GameManager.Instance.score", "[Main Camera].transform.position". In JS expressions use $("path").',
        'Start with game_eval "$tree()" to see the scene, and "$inspect(\'Player\')" to see an object and its components.',
        this.info.inputSystem ? 'Input goes straight into the Input System; the real mouse and keyboard are untouched.' : 'WARNING: this project has no Input System package, so input cannot be injected.',
      ],
    };
  }

  need() { if (!this.sock) throw new Error('no game is open: call game_open first'); }
  get screenH() { return this.info?.screen?.[1] ?? 720; }

  // ---------- 입력 ----------
  // Unity 입력은 "상태"라서, 누르고 바로 떼면 게임이 못 본다. press/click 은 다음 진행 프레임 한 번만 누른 상태로 둔다.
  async input(actions) {
    this.need();
    const done = [];
    for (const a of actions) {
      switch (a.type) {
        case 'key':
          if (a.action === 'down') this.held.keys.add(a.key);
          else if (a.action === 'up') this.held.keys.delete(a.key);
          else this.taps.keys.add(a.key);
          break;
        case 'mouse':
          if (a.x !== undefined) this.pointer = { x: a.x, y: this.screenH - a.y };
          if (a.action === 'down') this.held.buttons.add(a.button || 'left');
          else if (a.action === 'up') this.held.buttons.delete(a.button || 'left');
          else this.taps.buttons.add(a.button || 'left');
          break;
        case 'move': this.pointer = { x: a.x, y: this.screenH - a.y }; break;
        case 'look': this.pendingLook = { x: a.dx || 0, y: -(a.dy || 0) }; break;
        case 'text': for (const ch of a.text) this.taps.keys.add(ch === ' ' ? 'Space' : ch); break;
        case 'wait': break;
        default: throw new Error(`input type ${a.type} is not supported in Unity mode`);
      }
      done.push(a.type + (a.action ? ':' + a.action : '') + (a.key ? ':' + a.key : ''));
    }
    return { done, note: 'applied on the next game_step frame (Unity reads input state per frame)' };
  }

  inputFor(hold = {}, look, withTaps) {
    const keys = new Set([...this.held.keys, ...(hold.keys || [])]);
    const buttons = new Set([...this.held.buttons, ...(hold.buttons || [])]);
    if (withTaps) { for (const k of this.taps.keys) keys.add(k); for (const b of this.taps.buttons) buttons.add(b); }
    const inp = { keys: [...keys], buttons: [...buttons], look: look ? { x: num(look.dx, 0), y: -num(look.dy, 0) } : { x: 0, y: 0 } };
    if (withTaps && this.pendingLook) inp.look = this.pendingLook;
    if (this.pointer) inp.pointer = this.pointer;
    return inp;
  }

  get hasTaps() { return this.taps.keys.size || this.taps.buttons.size || this.pendingLook; }
  clearTaps() { this.taps.keys.clear(); this.taps.buttons.clear(); this.pendingLook = null; }

  // ---------- 진행 ----------
  async step({ frames = 1, dt, hold = {}, look, watch = [], until, every = 1, samples, screenshot } = {}) {
    this.need();
    let n = Math.max(1, Math.round(num(frames, 1)));
    const dtMs = num(dt, 1000 / 60);
    const ws = watch.map(compileExpr);
    const stop = until ? compileExpr(until) : null;
    const reads = [...new Set([...watch.flatMap(pathsIn), ...pathsIn(until)])];
    const series = watch.map(() => []);
    every = Math.max(1, Math.round(num(every, 1)));
    let ran = 0, met = false, last;
    const evalErr = [];

    const consume = (frame, vals) => {
      const map = new Map(reads.map((p, i) => [p, vals[i]]));
      const get = (p) => { if (!map.has(p)) throw new Error(`path ${p} was not read: write it as a literal $("...")`); const v = map.get(p); if (typeof v === 'string' && v.startsWith('ERR ')) throw new Error(v.slice(4)); return v; };
      ws.forEach((fn, j) => { let v; try { v = fn(get); } catch (e) { v = 'ERR ' + e.message; if (evalErr.length < 3) evalErr.push(e.message); } series[j].push([frame, v]); });
      if (stop) { try { met = !!stop(get); } catch (e) { if (evalErr.length < 3) evalErr.push(e.message); } }
    };

    // 탭 입력이 있으면 첫 프레임만 따로 진행한다. until 이 있으면 정확한 프레임에서 멈추려고 한 프레임씩 진행한다.
    const oneByOne = !!stop;
    while (ran < n && !met) {
      const taps = this.hasTaps;
      const chunk = taps || oneByOne ? 1 : n - ran;
      const isLast = ran + chunk >= n;
      last = await this.call('step', {
        frames: chunk, dt: dtMs, input: this.inputFor(hold, look, taps), read: reads,
        every: chunk > 1 ? every : 1, capture: !!screenshot && isLast, maxWidth: Math.round((this.info?.screen?.[0] ?? 1280) * 0.6),
      });
      if (taps) this.clearTaps();
      ran += last.framesRun;
      for (const [frame, vals] of last.series || []) consume(frame, vals);
    }
    // 진행이 끝나면 hold 로 누른 것은 놓는다 (웹 모드와 같은 의미). 다음 프레임에 반영된다.
    const out = { mode: 'unity', framesRun: ran, frame: last.frame, gameTime: last.time };
    if (last.captureMethod && last.captureMethod !== 'screen') out.captureNote = 'screen copy came back black on this graphics API; the image was rendered from the cameras, so OnGUI/overlay UI is missing';
    if (stop) out.untilMet = met;
    if (watch.length) out.watch = Object.fromEntries(watch.map((w, j) => [w, summarize(series[j], Math.min(200, num(samples, 12)))]));
    if (evalErr.length) out.expressionErrors = evalErr;
    if (screenshot && !last.jpeg) last.jpeg = (await this.call('capture', { maxWidth: Math.round((this.info?.screen?.[0] ?? 1280) * 0.6) })).jpeg;
    this.lastJpeg = last.jpeg;
    return out;
  }

  // 정책 코드를 매 프레임 Node에서 돌리고, 그 프레임의 입력으로 한 프레임씩 진행한다
  async control({ policy, frames = 600, dt, watch = [], until, every, samples, shots = 0, cols = 4, scale = 0.3, reset = false, read = [] } = {}) {
    if (reset) await this.open({ ...this.lastOpen });
    this.need();
    let fn;
    try { fn = new Function('ctx', '$', policy); } catch (e) { return { ok: false, error: 'policy does not compile: ' + e.message }; }
    const total = Math.round(num(frames, 600)), dtMs = num(dt, 1000 / 60);
    const reads = [...new Set([...pathsIn(policy), ...read, ...watch.flatMap(pathsIn), ...pathsIn(until)])];
    const ws = watch.map(compileExpr), stop = until ? compileExpr(until) : null;
    const series = watch.map(() => []);
    const mem = {}, logs = [];
    const shotEvery = shots > 0 ? Math.max(1, Math.floor(total / shots)) : 0;
    const tiles = [];
    let vals = (await this.call('read', { paths: reads })).values;
    let frame = 0, i = 0, met = false, error = null, inputFrames = 0, last;
    const getter = () => { const map = new Map(reads.map((p, k) => [p, vals[k]])); return (p) => { if (!map.has(p)) throw new Error(`path ${p} is not read: use a literal $("...") or list it in read`); const v = map.get(p); if (typeof v === 'string' && v.startsWith('ERR ')) throw new Error(v.slice(4)); return v; }; };

    for (; i < total; i++) {
      const get = getter();
      let r;
      try {
        r = fn({ i, frame, dt: dtMs, mem, log: (m) => { if (logs.length < 200) logs.push([i, String(m).slice(0, 200)]); } }, get) || {};
      } catch (e) { error = { i, frame, error: e.message }; break; }
      if ((r.keys?.length || r.buttons?.length)) inputFrames++;
      const capture = shotEvery > 0 && ((i + 1) % shotEvery === 0);
      last = await this.call('step', {
        frames: 1, dt: dtMs, read: reads, capture, maxWidth: Math.round((this.info?.screen?.[0] ?? 1280) * 0.6),
        input: { keys: r.keys || [], buttons: r.buttons || [], look: r.look ? { x: r.look.dx || 0, y: -(r.look.dy || 0) } : { x: 0, y: 0 }, ...(this.pointer ? { pointer: this.pointer } : {}) },
      });
      frame = last.frame;
      vals = last.series?.[0]?.[1] ?? vals;
      if (capture && last.jpeg) tiles.push({ b64: last.jpeg, label: `f${frame}` });
      const g2 = getter();
      ws.forEach((w, j) => { if (i % Math.max(1, num(every, 1)) === 0) { let v; try { v = w(g2); } catch (e) { v = 'ERR ' + e.message; } series[j].push([frame, v]); } });
      if (stop) { try { met = !!stop(g2); } catch { met = false; } if (met) { i++; break; } }
    }
    // 마지막에 모든 입력을 놓는다
    await this.call('step', { frames: 1, dt: dtMs, input: { keys: [], buttons: [], look: { x: 0, y: 0 } } });
    const out = { ok: !error, framesRun: i, controlTimeMs: Math.round(i * dtMs), frame, framesWithInput: inputFrames };
    if (until) out.untilMet = met;
    if (error) out.policyError = error;
    if (logs.length) out.policyLog = logs;
    if (Object.keys(mem).length) out.mem = mem;
    if (watch.length) out.watch = Object.fromEntries(watch.map((w, j) => [w, summarize(series[j], Math.min(200, num(samples, 12)))]));
    if (tiles.length) out.tiles = tiles.map((t) => t.label);
    return { summary: out, sheet: tiles.length ? await this.sheet(tiles, cols, scale) : null };
  }

  // ---------- 보기 ----------
  async screenshot({ scale = 0.6 } = {}) {
    this.need();
    return (await this.call('capture', { maxWidth: Math.round((this.info?.screen?.[0] ?? 1280) * scale) })).jpeg;
  }

  async sheet(tiles, cols, scale) {
    // 이미지 합성은 Windows 헬퍼를 빌려 쓴다
    this.sheetHelper ??= new Helper();
    return (await this.sheetHelper.call('sheet', { tiles: tiles.map((t) => t.b64), labels: tiles.map((t) => t.label), cols, scale: scale / 0.6 })).jpeg;
  }

  async filmstrip({ frames = 120, shots = 8, cols = 4, scale = 0.3, hold = {}, look, watch = [], dt } = {}) {
    const each = Math.max(1, Math.floor(num(frames, 120) / shots));
    const tiles = [], results = [];
    for (let k = 0; k < shots; k++) {
      const r = await this.step({ frames: each, dt, hold, look, watch, screenshot: true });
      results.push(r);
      tiles.push({ b64: this.lastJpeg, label: `f${r.frame}` });
    }
    const lastOf = (x) => (!x ? null : 'constant' in x ? x.constant : 'last' in x ? x.last : x.changes?.at(-1)?.[1] ?? null);
    const summary = { mode: 'unity', framesRun: results.reduce((a, r) => a + r.framesRun, 0), frame: results.at(-1).frame, tiles: tiles.map((t) => t.label) };
    if (watch.length) summary.watchAtEachTile = Object.fromEntries(watch.map((w) => [w, results.map((r) => lastOf(r.watch?.[w]))]));
    return { sheet: await this.sheet(tiles, cols, scale), summary };
  }

  // JS 를 Node에서 실행하고, 게임과는 $ 도우미로 대화한다
  async eval(code, depth = 3) {
    this.need();
    const $ = async (p) => { const v = (await this.call('read', { paths: [p] })).values[0]; if (typeof v === 'string' && v.startsWith('ERR ')) throw new Error(v.slice(4)); return v; };
    const helpers = {
      $,
      $set: async (p, value) => (await this.call('set', { path: p, value })).value,
      $call: async (p, ...args) => (await this.call('call', { path: p, args })).value,
      $inspect: async (p, d = depth) => (await this.call('inspect', { path: p, depth: d })).value,
      $tree: async (d = 2, root) => (await this.call('tree', { depth: d, root })).tree,
    };
    // 식이면 값, 문장이면 함수 본문. $("x") 처럼 await 없이 써도 되게 식 안의 도우미 호출을 기다린다
    let fn;
    try { fn = new Function(...Object.keys(helpers), `return (async () => (${code}))();`); }
    catch { fn = new Function(...Object.keys(helpers), `return (async () => { ${code} })();`); }
    try {
      let v = await fn(...Object.values(helpers));
      if (v && typeof v.then === 'function') v = await v;
      return { ok: true, value: v };
    } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 1500) }; }
  }

  async setRunning(running) { this.need(); return this.call('realtime', { running }); }

  async getLogs({ clear = false } = {}) {
    const game = this.sock ? (await this.call('logs', { clear })).logs : [];
    return [...this.logs.map((t) => ({ type: 'gameprobe', text: t })), ...game.map((t) => ({ type: 'unity', text: t }))].slice(-80);
  }

  async close() {
    if (this.child) this.child.closing = true;
    if (this.sock) {
      if (this.child && !this.keepRunning) await this.call('quit', {}, 3000).catch(() => {});
      else await this.call('realtime', { running: true }, 3000).catch(() => {});
      this.sock.destroy(); this.sock = null;
    }
    if (this.child && !this.keepRunning) { this.child.closing = true; await sleep(500); try { this.child.kill(); } catch { /* gone */ } }
    this.child = null;
    if (this.sheetHelper) { this.sheetHelper.close(); this.sheetHelper = null; }
  }
}

// 같은 시나리오 실행기(game_run)는 웹 세션 것을 그대로 쓴다: open / input / eval / step 이름이 같다
UnitySession.prototype.run = Session.prototype.run;
