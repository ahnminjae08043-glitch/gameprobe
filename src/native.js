// 범용 폴백: 엔진과 상관없이 어떤 게임 창에든 붙는다 (현재 Windows).
// 게임 안을 들여다볼 수 없으므로 시간은 "프로세스 얼리기"로, 상태는 "화면"으로 다룬다.
//   - 에이전트가 생각하는 동안 게임 프로세스를 얼려 둔다 (NtSuspendProcess). step 할 때만 실제 시간으로 녹인다.
//   - 입력은 OS 수준 스캔코드/마우스 (SendInput). raw input 을 쓰는 게임도 받는다.
//   - until 은 화면 영역의 변화나 색으로 건다.
// 웹 세션과 같은 메서드 이름을 써서 MCP 도구가 그대로 통한다.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER_SRC = path.join(HERE, '..', 'native', 'win', 'helper.cs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 처음 쓸 때 Windows에 기본으로 있는 csc.exe 로 헬퍼를 빌드하고, 소스가 바뀌면 다시 빌드한다
function buildHelper() {
  if (process.platform !== 'win32') throw new Error('native mode currently supports Windows only');
  const src = fs.readFileSync(HELPER_SRC);
  const hash = createHash('sha1').update(src).digest('hex').slice(0, 10);
  const dir = path.join(os.homedir(), '.gameprobe');
  const exe = path.join(dir, `gp-helper-${hash}.exe`);
  if (fs.existsSync(exe)) return exe;
  fs.mkdirSync(dir, { recursive: true });
  const windir = process.env.WINDIR || 'C:\\Windows';
  const csc = [path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find((p) => fs.existsSync(p));
  if (!csc) throw new Error('csc.exe (.NET Framework 4) not found; it ships with Windows 10/11');
  execFileSync(csc, ['-nologo', '-optimize', '-r:System.Web.Extensions.dll', '-r:System.Drawing.dll', `-out:${exe}`, HELPER_SRC], { stdio: 'pipe' });
  return exe;
}

class Helper {
  constructor() {
    this.proc = spawn(buildHelper(), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.waiting = new Map();
    this.nextId = 1;
    const rl = readline.createInterface({ input: this.proc.stdout });
    this.ready = new Promise((res) => {
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.ready) return res();
        const w = this.waiting.get(msg.id);
        if (!w) return;
        this.waiting.delete(msg.id);
        msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg);
      });
    });
    this.proc.on('exit', () => { for (const w of this.waiting.values()) w.reject(new Error('helper exited')); this.waiting.clear(); });
  }

  async call(cmd, args = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  close() { try { this.proc.stdin.end(); } catch { /* already gone */ } }
}

// 안티치트가 깔린 게임에 입력을 주입하거나 프로세스를 얼리면 계정이 정지될 수 있다
const ANTICHEAT = /easyanticheat|battleye|beservice|vgk|vanguard|xigncode|nprotect|gameguard|faceit|ricochet|anticheat/i;
function findAntiCheat(dir, depth = 3) {
  if (depth < 0) return null;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (ANTICHEAT.test(e.name)) return path.join(dir, e.name);
    if (e.isDirectory()) { const hit = findAntiCheat(path.join(dir, e.name), depth - 1); if (hit) return hit; }
  }
  return null;
}

export class NativeSession {
  constructor() {
    this.helper = null;
    this.win = null;
    this.child = null;
    this.frozen = false;
    this.logs = [];
  }

  log(type, text) { this.logs.push({ type, text: String(text).slice(0, 1000) }); if (this.logs.length > 300) this.logs.shift(); }

  async open({ exe, args = [], window: titleMatch, pid, paused = true, startupMs = 0, timeoutMs = 60000, allowAntiCheat = false, keepRunning = false, capture = 'screen' } = {}) {
    await this.close();
    this.method = capture;
    this.helper = new Helper();
    this.keepRunning = keepRunning;

    if (exe) {
      const ac = findAntiCheat(path.dirname(exe));
      if (ac && !allowAntiCheat) {
        throw new Error(`anti-cheat files found (${ac}). Injecting input or suspending this game can get the account banned. Refusing; pass allowAntiCheat: true only for your own game or a single-player game you are sure about.`);
      }
    }

    const before = new Set((await this.helper.call('windows')).windows.map((w) => w.hwnd));
    if (exe) {
      this.child = spawn(exe, args, { cwd: path.dirname(exe), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child.stdout.on('data', (d) => this.log('stdout', d));
      this.child.stderr.on('data', (d) => this.log('stderr', d));
      this.child.on('exit', (code) => this.log('exit', `game process exited with code ${code}`));
    }

    // 창 찾기: pid → 제목 → 실행 뒤 새로 생긴 창 중 가장 큰 것.
    // 런처가 진짜 게임 프로세스를 따로 띄우는 경우(언리얼, 많은 스팀 게임)가 흔해서 pid만 믿을 수 없다.
    const t0 = Date.now();
    const re = titleMatch ? new RegExp(titleMatch, 'i') : null;
    let win = null;
    while (!win && Date.now() - t0 < timeoutMs) {
      const all = (await this.helper.call('windows')).windows;
      let cands = all;
      if (pid) cands = cands.filter((w) => w.pid === pid);
      else if (re) cands = cands.filter((w) => re.test(w.title) || re.test(w.exe));
      else if (exe) cands = cands.filter((w) => !before.has(w.hwnd));
      else throw new Error('give exe, window (title/exe regex) or pid');
      cands.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
      win = cands[0];
      if (!win) await sleep(500);
    }
    if (!win) throw new Error(`no game window found within ${timeoutMs} ms`);
    this.win = win;
    if (startupMs) await sleep(startupMs);

    // 창이 막 뜬 직후에는 크기가 바뀌는 경우가 많다 (스플래시 → 본 창)
    const rect = (await this.helper.call('rect', { hwnd: win.hwnd })).rect;
    this.win.rect = rect;
    await this.helper.call('focus', { hwnd: win.hwnd });
    if (paused) await this.freeze(true);

    return {
      mode: 'native', window: { title: win.title, exe: win.exe, pid: win.pid, width: rect.w, height: rect.h },
      paused, launched: !!exe,
      notes: [
        'Native mode: no access to game internals. Use screenshots, game_filmstrip and untilScreen (screen region change or colour).',
        'Time is real but frozen between your calls: the game process is suspended while you think and runs only during game_step.',
        'Input goes through the OS and takes over the real mouse and keyboard while it runs.',
      ],
    };
  }

  need() { if (!this.win) throw new Error('no game is open: call game_open first'); return this.win; }

  async freeze(on) {
    const ok = (await this.helper.call(on ? 'suspend' : 'resume', { pid: this.win.pid })).ok;
    if (ok) this.frozen = on;
    return ok;
  }

  async focus() {
    const r = await this.helper.call('focus', { hwnd: this.win.hwnd });
    if (!r.focused) this.log('warning', 'could not bring the game window to the front; input may go elsewhere');
    return r.focused;
  }

  async key(key, down) { await this.helper.call('key', { key, down }); }
  async button(button, down) { await this.helper.call('mouse', { action: down ? 'down' : 'up', button }); }

  // 입력은 게임이 돌고 있을 때 넣는다. 얼린 채로 넣으면 이벤트는 쌓이지만, UI가 "마우스가 버튼 위에 있다"는
  // 걸 프레임으로 확인하기 전에 클릭이 끝나버려 엔진 UI(언리얼 Slate 등)가 무시한다.
  async input(actions) {
    const w = this.need();
    const focused = await this.focus();
    // 다음 game_step 의 untilScreen 이 "입력하기 전 화면"과 비교하도록 저장해 둔다.
    // 안 그러면 입력 처리 중에 이미 바뀐 화면이 기준이 되어 변화가 0으로 보인다.
    this.preInput = await this.probe().catch(() => null);
    const was = this.frozen;
    if (was) await this.freeze(false);
    const done = [];
    try {
      for (const a of actions) {
        switch (a.type) {
          case 'key':
            if (a.action === 'down') await this.key(a.key, true);
            else if (a.action === 'up') await this.key(a.key, false);
            else { await this.key(a.key, true); await sleep(60); await this.key(a.key, false); }
            break;
          case 'text':
            for (const ch of a.text) { const k = ch === ' ' ? 'Space' : ch; await this.key(k, true); await sleep(30); await this.key(k, false); await sleep(30); }
            break;
          case 'mouse': {
            if (a.x !== undefined) { await this.helper.call('mouse', { hwnd: w.hwnd, action: 'move', x: a.x, y: a.y }); await sleep(150); }
            const b = a.button || 'left';
            if (a.action === 'down' || a.action === 'up') await this.button(b, a.action === 'down');
            else { await this.button(b, true); await sleep(80); await this.button(b, false); }
            break;
          }
          case 'move': await this.helper.call('mouse', { hwnd: w.hwnd, action: 'move', x: a.x, y: a.y }); break;
          case 'look': await this.helper.call('mouse', { action: 'moveRel', dx: a.dx || 0, dy: a.dy || 0 }); break;
          case 'wheel': await this.helper.call('mouse', { action: 'wheel', dy: a.dy || 0 }); break;
          case 'wait': await sleep(a.ms || 100); break;
          default: throw new Error(`unknown input type: ${a.type}`);
        }
        done.push(a.type + (a.action ? ':' + a.action : '') + (a.key ? ':' + a.key : ''));
      }
      await sleep(150); // 마지막 입력이 게임 프레임에 반영되게
    } finally {
      if (was) await this.freeze(true);
    }
    return { done, focused, ranMs: 'about 150 ms per click/key while unfrozen' };
  }

  // 얼어 있으면 잠깐 녹여서 진행시킨다 (클릭 같은 짧은 입력이 먹히려면 게임이 돌아야 한다)
  async tick(ms) {
    const was = this.frozen;
    if (was) await this.freeze(false);
    await sleep(ms);
    if (was) await this.freeze(true);
  }

  // until 조건: 화면 영역이 시작 때보다 바뀌었는지, 또는 특정 색이 되었는지
  async probe(region) {
    const [x, y, w, h] = region || [0, 0, this.win.rect.w, this.win.rect.h];
    return (await this.call('probe', { hwnd: this.win.hwnd, x, y, w, h, method: this.captureMethod })).probe;
  }
  // 평균 변화(화면 전체가 바뀌었나)와 최대 칸 변화(어딘가 한 곳이 바뀌었나)를 둘 다 본다.
  // 어두운 메뉴에서 글자 한 줄이 바뀌는 건 평균으로는 거의 안 잡힌다.
  static diff(a, b) {
    let s = 0, m = 0;
    for (let i = 0; i < a.sig.length; i++) { const d = Math.abs(a.sig[i] - b.sig[i]); s += d; if (d > m) m = d; }
    return { mean: s / a.sig.length / 255, max: m / 255 };
  }
  static colorDist(p, hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return Math.max(Math.abs(p.r - (n >> 16)), Math.abs(p.g - ((n >> 8) & 255)), Math.abs(p.b - (n & 255)));
  }

  async step({ frames, ms, hold = {}, look, untilScreen, pollMs = 60 } = {}) {
    this.need();
    const dur = ms ?? ((frames ?? 60) * 1000) / 60;
    const keys = hold.keys || [], buttons = hold.buttons || [];
    let base = null;
    if (untilScreen) {
      base = !untilScreen.region && this.preInput ? this.preInput : await this.probe(untilScreen.region);
    }
    this.preInput = null;

    await this.focus();
    for (const k of keys) await this.key(k, true);
    for (const b of buttons) await this.button(b, true);
    const was = this.frozen;
    if (was) await this.freeze(false);

    const t0 = Date.now();
    let met = false, lastPoll = 0, last = null, polls = 0;
    try {
      while (Date.now() - t0 < dur) {
        if (look && (look.dx || look.dy)) await this.helper.call('mouse', { action: 'moveRel', dx: look.dx || 0, dy: look.dy || 0 });
        if (untilScreen && Date.now() - lastPoll >= pollMs) {
          lastPoll = Date.now(); polls++;
          last = await this.probe(untilScreen.region);
          const d = NativeSession.diff(base, last);
          if (untilScreen.change !== undefined && d.mean >= untilScreen.change) met = true;
          if (untilScreen.anyChange !== undefined && d.max >= untilScreen.anyChange) met = true;
          if (untilScreen.color && NativeSession.colorDist(last, untilScreen.color) <= (untilScreen.tolerance ?? 24)) met = true;
          if (met) break;
        }
        await sleep(16);
      }
    } finally {
      for (const b of buttons) await this.button(b, false);
      for (const k of keys) await this.key(k, false);
      if (was) await this.freeze(true);
    }
    const out = { mode: 'native', elapsedMs: Date.now() - t0, frozenNow: this.frozen };
    if (untilScreen) {
      out.untilMet = met;
      const d = NativeSession.diff(base, last || base);
      out.screen = { change: +d.mean.toFixed(3), maxCellChange: +d.max.toFixed(3), avgColor: last ? '#' + [last.r, last.g, last.b].map((v) => v.toString(16).padStart(2, '0')).join('') : null, polls };
    }
    return out;
  }

  // 기본은 화면에서 직접 복사한다. PrintWindow 는 얼어 있는 창에서는 멈추고, D3D12 같은 플립 모델
  // 스왑체인에서는 그럴듯한 빈 프레임을 돌려줘서 화면 변화 감지를 속인다. 화면 복사는 창이 맨 앞에 있어야 한다.
  get captureMethod() { return this.frozen ? 'screen' : this.method; }
  async capture(maxWidth) {
    const w = this.need();
    await this.focus();
    return this.call('capture', { hwnd: w.hwnd, maxWidth, quality: 75, method: this.captureMethod });
  }

  // 헬퍼가 멈추면 죽이고, 새 헬퍼로 게임부터 녹인다. 게임을 언 채로 버려두는 일은 없어야 한다.
  async call(cmd, args) {
    try {
      return await this.helper.call(cmd, args);
    } catch (e) {
      if (!e.stuck) throw e;
      this.helper.kill();
      this.helper = new Helper();
      if (this.win) { await this.helper.call('resume', { pid: this.win.pid }).catch(() => {}); this.frozen = false; }
      throw new Error(`${e.message}; the helper was restarted and the game was resumed`);
    }
  }

  async screenshot({ scale = 0.6 } = {}) {
    const r = await this.capture(Math.round(this.win.rect.w * scale));
    return r.jpeg;
  }

  async filmstrip({ frames = 120, ms, shots = 8, cols = 4, scale = 0.3, hold = {}, look } = {}) {
    const total = ms ?? (frames * 1000) / 60;
    const each = total / shots;
    const tiles = [], labels = [];
    let t = 0;
    for (let i = 0; i < shots; i++) {
      await this.step({ ms: each, hold, look });
      t += each;
      tiles.push((await this.capture(Math.round(this.win.rect.w * 0.6))).jpeg);
      labels.push(`${(t / 1000).toFixed(2)}s`);
    }
    const sheet = (await this.helper.call('sheet', { tiles, labels, cols, scale: scale / 0.6 })).jpeg;
    return { sheet, summary: { mode: 'native', tiles: labels, totalMs: Math.round(total) } };
  }

  async eval() {
    return { ok: false, error: 'native mode cannot read game internals. Use game_screenshot / game_filmstrip, or game_step with untilScreen.' };
  }

  async run() { throw new Error('game_run is web-only for now (native games cannot be reset to an identical state)'); }

  async setRunning(running) {
    this.need();
    await this.freeze(!running);
    return { frozen: this.frozen };
  }

  getLogs({ clear = false } = {}) {
    const out = this.logs.slice(-80);
    if (clear) this.logs = [];
    return out;
  }

  async close() {
    if (this.helper) {
      // 게임을 얼린 채로 두지 않는다
      if (this.win && this.frozen) await this.freeze(false).catch(() => {});
      this.helper.close();
    }
    if (this.child && !this.keepRunning) {
      try { process.kill(this.win?.pid ?? this.child.pid); } catch { /* gone */ }
      try { this.child.kill(); } catch { /* gone */ }
    }
    this.helper = null; this.win = null; this.child = null; this.frozen = false;
  }
}
