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
  let vt = realNow();       // 멈춰 있을 때의 가상 시각 (ms)
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
  function summarize(samples) {
    const nums = samples.filter(([, v]) => typeof v === 'number');
    if (nums.length === samples.length && nums.length) {
      const vs = nums.map(([, v]) => v);
      const pick = [];
      const k = Math.max(1, Math.ceil(nums.length / 12));
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
    step({ frames = 1, dt = 1000 / 60, lookDx = 0, lookDy = 0, watch = [], until = null, every = 1, speed = 0 } = {}) {
      this.pause();
      const ws = watch.map(compile);
      const series = watch.map(() => []);
      const stop = until ? compile(until) : null;
      const e0 = errors.length;
      let ran = 0, met = false;

      // 한 프레임 진행. 멈춰야 하면 true
      const tick = (i) => {
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
        if (watch.length) out.watch = Object.fromEntries(watch.map((w, j) => [w, summarize(series[j])]));
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
