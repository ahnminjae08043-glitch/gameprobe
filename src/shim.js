// 페이지가 로드되기 전에 주입되는 코드. 게임 코드는 한 줄도 고치지 않는다.
//
// 1. 가상 시간: requestAnimationFrame / performance.now / Date.now 를 가로채서
//    에이전트가 "N프레임 진행"을 결정적으로 시킬 수 있게 한다.
//    실제 rAF에 의존하지 않으므로 숨겨진 탭이나 헤드리스에서도 멈추지 않는다.
// 2. 포인터 락 대체: 헤드리스에서는 진짜 포인터 락이 거부되므로 흉내낸다.
// 3. 시선(마우스 델타) 주입: 포인터 락 게임은 movementX/Y 만 보므로 합성 이벤트로 넣는다.
//
// 이 함수는 문자열로 직렬화되어 페이지에서 실행된다. 바깥 스코프를 참조하면 안 된다.
export function shim(seed) {
  if (window.__gp) return;

  // 시드 고정 난수: 같은 입력이면 같은 결과가 나오게 한다 (mulberry32)
  if (seed !== null && seed !== undefined) {
    let a = seed >>> 0;
    Math.random = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const realRAF = window.requestAnimationFrame.bind(window);
  const realNow = performance.now.bind(performance);
  const realDateNow = Date.now.bind(Date);
  const dateBase = realDateNow() - realNow();

  let paused = true;
  let vt = 0;               // 멈춰 있을 때의 가상 시각 (ms). 0에서 시작해야 실행마다 절대 시각까지 같다
  let offset = 0;           // 돌아갈 때: clock = realNow() - offset
  const clock = () => (paused ? vt : realNow() - offset);

  let cbs = new Map();
  let nextId = 1;
  let frame = 0;
  const errors = [];

  window.requestAnimationFrame = (cb) => { const id = nextId++; cbs.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { cbs.delete(id); };
  performance.now = () => clock();
  Date.now = () => Math.round(dateBase + clock());

  function runFrame() {
    const q = cbs;
    cbs = new Map();
    const t = clock();
    for (const cb of q.values()) {
      try { cb(t); } catch (e) { errors.push({ frame, error: String((e && e.stack) || e) }); }
    }
    frame++;
  }

  // 실시간 모드: 실제 rAF가 가상 프레임을 하나씩 밀어준다
  function pump() {
    realRAF(pump);
    if (!paused) runFrame();
  }
  realRAF(pump);

  // ---------- 포인터 락 ----------
  let lockEl = null;
  const lockChange = () => Promise.resolve().then(() => document.dispatchEvent(new Event('pointerlockchange')));
  Object.defineProperty(Document.prototype, 'pointerLockElement', { configurable: true, get() { return lockEl; } });
  Element.prototype.requestPointerLock = function () { lockEl = this; lockChange(); return Promise.resolve(); };
  Document.prototype.exitPointerLock = function () { if (lockEl) { lockEl = null; lockChange(); } };

  // ---------- 마우스 ----------
  let mx = innerWidth / 2, my = innerHeight / 2;
  addEventListener('mousemove', (e) => { if (e.isTrusted) { mx = e.clientX; my = e.clientY; } }, true);
  function look(dx, dy) {
    const target = lockEl || document.elementFromPoint(mx, my) || document.body;
    target.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, composed: true,
      clientX: mx, clientY: my, movementX: dx, movementY: dy,
    }));
  }

  // ---------- 반사 코드 (game_control) ----------
  // 에이전트(느림)가 짠 코드를 매 프레임(빠름) 실행한다. 코드는 원하는 입력 상태만 돌려주고,
  // 여기서 이전 프레임과 비교해 keydown/keyup, mousedown/mouseup 을 만들어 넣는다.
  const KEYCODE = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Space: 32, Enter: 13, Escape: 27,
    ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17, AltLeft: 18, Tab: 9, Backspace: 8 };
  const keyOf = (code) => (code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5)
    : code === 'Space' ? ' ' : code);
  const keyCodeOf = (code) => KEYCODE[code] || (code.startsWith('Key') ? code.charCodeAt(3) : code.startsWith('Digit') ? code.charCodeAt(5) : 0);
  function sendKey(type, code) {
    const e = new KeyboardEvent(type, { code, key: keyOf(code), bubbles: true, cancelable: true, composed: true });
    const kc = keyCodeOf(code);
    Object.defineProperty(e, 'keyCode', { get: () => kc });
    Object.defineProperty(e, 'which', { get: () => kc });
    (document.activeElement || document.body).dispatchEvent(e);
  }
  const BTN = { left: 0, middle: 1, right: 2 };
  function sendButton(type, b) {
    const target = lockEl || document.elementFromPoint(mx, my) || document.body;
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, button: BTN[b] ?? 0,
      buttons: type === 'mousedown' ? 1 << (BTN[b] ?? 0) : 0, clientX: mx, clientY: my }));
    target.dispatchEvent(new PointerEvent(type === 'mousedown' ? 'pointerdown' : 'pointerup', { bubbles: true, button: BTN[b] ?? 0, clientX: mx, clientY: my, pointerType: 'mouse' }));
  }
  let ctl = null;
  function runPolicy() {
    const c = ctl;
    const ctx = { frame, i: c.i++, t: clock(), dt: c.dt, mem: c.mem, held: [...c.keys], buttons: [...c.buttons],
      log: (m) => { if (c.logs.length < 200) c.logs.push([frame, String(m).slice(0, 200)]); } };
    let r;
    try { r = c.fn(ctx) || {}; } catch (e) {
      // 첫 줄(메시지)과 정책 코드 안의 위치만 남긴다
      const lines = String((e && e.stack) || e).split('\n');
      const at = lines.find((l) => l.includes('<anonymous>:') && l.includes('setPolicy'));
      const m = at && at.match(/<anonymous>:(\d+):(\d+)/);
      c.error = { frame, i: ctx.i, error: lines[0] + (m ? ` (policy line ${m[1] - 2}, col ${m[2]})` : '') };
      return false;
    }
    const wantK = new Set(r.keys || []), wantB = new Set(r.buttons || []);
    for (const k of c.keys) if (!wantK.has(k)) sendKey('keyup', k);
    for (const k of wantK) if (!c.keys.has(k)) sendKey('keydown', k);
    for (const b of c.buttons) if (!wantB.has(b)) sendButton('mouseup', b);
    for (const b of wantB) if (!c.buttons.has(b)) sendButton('mousedown', b);
    c.keys = wantK; c.buttons = wantB;
    if (r.look && (r.look.dx || r.look.dy)) look(r.look.dx || 0, r.look.dy || 0);
    c.inputFrames += wantK.size || wantB.size ? 1 : 0;
    return true;
  }

  // ---------- 관찰 ----------
  const compile = (expr) => {
    try { return new Function(`return (${expr});`); }
    catch (e) { const msg = 'ERR ' + e.message; return () => msg; }
  };
  const read = (fn) => {
    try { return snapshot(fn(), 2); } catch (e) { return 'ERR ' + e.message; }
  };

  // three.js 객체처럼 순환·거대한 값을 에이전트가 읽을 수 있는 크기로 줄인다
  function snapshot(v, depth = 3, seen = new WeakSet()) {
    if (v === null || v === undefined) return v ?? null;
    const t = typeof v;
    if (t === 'number') return Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : String(v);
    if (t === 'string') return v.length > 300 ? v.slice(0, 300) + '...' : v;
    if (t === 'boolean') return v;
    if (t === 'function') return undefined;
    if (t === 'bigint' || t === 'symbol') return String(v);
    if (v instanceof Element) return `<${v.tagName.toLowerCase()}${v.id ? '#' + v.id : ''}>`;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (ArrayBuffer.isView(v)) v = Array.from(v.slice(0, 32));
    if (Array.isArray(v)) {
      if (depth <= 0) return `[array(${v.length})]`;
      const out = v.slice(0, 40).map((x) => snapshot(x, depth - 1, seen));
      if (v.length > 40) out.push(`... ${v.length - 40} more`);
      return out;
    }
    if (v instanceof Map) v = Object.fromEntries([...v].slice(0, 40));
    if (v instanceof Set) return snapshot([...v], depth, seen);
    const name = v.constructor && v.constructor.name;
    if (depth <= 0) return `[${name || 'object'}]`;
    const out = {};
    let n = 0;
    for (const k in v) {
      if (k.startsWith('_')) continue;
      let x;
      try { x = v[k]; } catch { continue; }
      if (typeof x === 'function') continue;
      if (++n > 40) { out['...'] = 'more keys'; break; }
      out[k] = snapshot(x, depth - 1, seen);
    }
    return out;
  }

  // 시계열을 짧게: 숫자면 처음/끝/최소/최대와 표본 몇 개, 그 외에는 값이 바뀐 순간만
  function summarize(samples, maxSamples = 12) {
    const nums = samples.filter(([, v]) => typeof v === 'number');
    if (nums.length === samples.length && nums.length) {
      const vs = nums.map(([, v]) => v);
      const pick = [];
      const k = Math.max(1, Math.ceil(nums.length / maxSamples));
      for (let i = 0; i < nums.length; i += k) pick.push(nums[i]);
      if (pick[pick.length - 1] !== nums[nums.length - 1]) pick.push(nums[nums.length - 1]);
      const min = Math.min(...vs), max = Math.max(...vs);
      if (min === max) return { constant: min };
      return { first: vs[0], last: vs[vs.length - 1], min, max, samples: pick };
    }
    const changes = [];
    let prev;
    for (const [f, v] of samples) {
      const s = JSON.stringify(v);
      if (s !== prev) { changes.push([f, v]); prev = s; }
    }
    return changes.length > 20
      ? { changes: changes.slice(0, 10).concat([['...', `${changes.length - 20} more`]], changes.slice(-10)) }
      : { changes };
  }

  window.__gp = {
    // 반사 코드 설치/해제. code 는 ctx 를 받아 { keys, buttons, look } 을 돌려주는 함수 본문.
    setPolicy(code, dt) {
      let fn;
      try { fn = new Function('ctx', code); } catch (e) { return { ok: false, error: 'policy does not compile: ' + e.message }; }
      ctl = { fn, dt, i: 0, mem: {}, keys: new Set(), buttons: new Set(), logs: [], error: null, inputFrames: 0 };
      return { ok: true };
    },
    clearPolicy() {
      if (!ctl) return null;
      for (const k of ctl.keys) sendKey('keyup', k);
      for (const b of ctl.buttons) sendButton('mouseup', b);
      const out = { logs: ctl.logs, error: ctl.error, framesWithInput: ctl.inputFrames, mem: snapshot(ctl.mem, 2) };
      ctl = null;
      return out;
    },
    get frame() { return frame; },
    get paused() { return paused; },
    pending: () => cbs.size,
    pause() { if (!paused) { vt = clock(); paused = true; } },
    resume() { if (paused) { offset = realNow() - vt; paused = false; } },
    look,
    errors,
    snapshot,

    // n 프레임을 dt(ms) 간격으로 진행. 매 프레임 시선 델타를 넣고, watch 식을 표본 추출하고,
    // until 식이 참이 되면 멈춘다.
    step({ frames = 1, dt = 1000 / 60, lookDx = 0, lookDy = 0, watch = [], until = null, every = 1, speed = 0, samples = 12 } = {}) {
      this.pause();
      const ws = watch.map(compile);
      const series = watch.map(() => []);
      const stop = until ? compile(until) : null;
      const e0 = errors.length;
      let ran = 0, met = false;

      // 한 프레임 진행. 멈춰야 하면 true
      const tick = (i) => {
        if (ctl && !runPolicy()) return true;   // 반사 코드가 에러를 내면 바로 멈춘다
        if (lookDx || lookDy) look(lookDx, lookDy);
        vt += dt;
        runFrame();
        ran++;
        if (ws.length && (i % every === 0 || i === frames - 1)) {
          ws.forEach((fn, j) => series[j].push([frame, read(fn)]));
        }
        if (stop) {
          let ok = false;
          try { ok = !!stop(); } catch { ok = false; }
          if (ok) {
            met = true;
            ws.forEach((fn, j) => { const s = series[j]; if (!s.length || s[s.length - 1][0] !== frame) s.push([frame, read(fn)]); });
            return true;
          }
        }
        return false;
      };

      const finish = () => {
        const out = { framesRun: ran, frame, gameTimeMs: Math.round(clock()) };
        if (stop) out.untilMet = met;
        if (watch.length) out.watch = Object.fromEntries(watch.map((w, j) => [w, summarize(series[j], samples)]));
        const errs = errors.slice(e0);
        if (errs.length) out.frameErrors = errs.slice(0, 5).map((e) => ({ frame: e.frame, error: e.error.slice(0, 600) })).concat(errs.length > 5 ? [{ more: errs.length - 5 }] : []);
        if (!cbs.size) out.warning = 'no requestAnimationFrame callback is pending: the game loop may have stopped or not started yet';
        return out;
      };

      if (!speed) {
        for (let i = 0; i < frames; i++) if (tick(i)) break;
        return finish();
      }
      // 관전 모드: 사람이 볼 수 있게 실제 시간에 맞춰(speed 배속) 진행한다. 결과는 위와 똑같다.
      return (async () => {
        const t0 = realNow();
        for (let i = 0; i < frames; i++) {
          if (tick(i)) break;
          const due = t0 + ((i + 1) * dt) / speed;
          while (realNow() < due - 2) await new Promise((r) => realRAF(r));
        }
        return finish();
      })();
    },

    // 관전 모드에서 지금 무엇을 하는지 화면 아래에 보여준다
    caption(text) {
      let el = document.getElementById('__gp_caption');
      if (!el) {
        el = document.createElement('div');
        el.id = '__gp_caption';
        el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;' +
          'max-width:90vw;padding:8px 14px;border-radius:6px;background:rgba(10,12,16,.82);color:#e8f0ff;' +
          'font:14px/1.4 Consolas,monospace;pointer-events:none;white-space:pre-wrap;border:1px solid rgba(120,170,255,.45)';
        document.documentElement.appendChild(el);
      }
      el.textContent = 'gameprobe  ' + text;
      el.style.display = text ? 'block' : 'none';
    },
  };
}
