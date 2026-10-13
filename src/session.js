// 브라우저 하나와 게임 페이지 하나를 다루는 세션. MCP 서버와 테스트가 같이 쓴다.
import { chromium } from 'playwright';
import { shim } from './shim.js';
import { serveDir } from './static.js';

const BUTTONS = { left: 'left', right: 'right', middle: 'middle' };

// 스윕에서 "1000/$fps" 같은 산술식이 숫자 자리에 오므로, 숫자·사칙연산만 허용해서 계산한다
function num(x, fallback) {
  if (x === undefined || x === null) return fallback;
  if (typeof x === 'number') return x;
  const s = String(x).trim();
  if (!/^[\d\s.+\-*/()eE]+$/.test(s)) throw new Error(`not a number or arithmetic expression: ${s}`);
  const v = Function(`return (${s});`)();
  if (!Number.isFinite(v)) throw new Error(`not a finite number: ${s}`);
  return v;
}

export class Session {
  constructor() {
    this.browser = null;
    this.page = null;
    this.server = null;
    this.logs = [];
    this.size = { width: 1280, height: 720 };
  }

  async open(opts = {}) {
    // 관전 모드: 창을 띄우고 실제 속도로 진행하며 자막을 띄운다. 환경변수로 서버 전체에 켤 수도 있다.
    const envVisible = process.env.GAMEPROBE_VISIBLE === '1';
    const visible = opts.visible ?? envVisible;
    const { url: givenUrl, dir, path = '/', width = 1280, height = 720, paused = true, warmupFrames = 2, browser, seed = 1 } = opts;
    const headless = visible ? false : (opts.headless ?? true);
    this.speed = visible ? Number(opts.speed ?? process.env.GAMEPROBE_SPEED ?? 1) : 0;
    let url = givenUrl;
    // 같은 실행 옵션이면 브라우저는 재사용하고 컨텍스트만 새로 만든다 (스윕에서 회차마다 1초씩 아낀다)
    const launchKey = JSON.stringify([headless, browser || null]);
    if (this.browser && this.launchKey === launchKey) await this.closeGame();
    else await this.close();
    this.launchKey = launchKey;
    this.lastOpen = opts;
    if (dir) {
      this.server = await serveDir(dir);
      url = this.server.url + path;
    }
    if (!url) throw new Error('give either url or dir');

    // 설치된 Chrome/Edge를 먼저 쓴다: 브라우저를 따로 받을 필요가 없고 실제 GPU로 그린다
    const channels = browser ? [browser] : ['chrome', 'msedge', undefined];
    let lastErr;
    for (const channel of this.browser ? [] : channels) {
      try {
        this.browser = await chromium.launch({ headless, channel, args: ['--autoplay-policy=no-user-gesture-required'] });
        this.channel = channel || 'bundled chromium';
        break;
      } catch (e) { lastErr = e; }
    }
    if (!this.browser) throw lastErr;

    this.size = { width, height };
    const ctx = this.ctx = await this.browser.newContext({ viewport: this.size, deviceScaleFactor: 1 });
    await ctx.addInitScript(`(${shim.toString()})(${seed === null ? 'null' : Number(seed)})`);
    this.page = await ctx.newPage();
    this.logs = [];
    this.page.on('console', (m) => {
      const at = m.location()?.url;
      this.log(m.type(), m.text() + (at && m.type() === 'error' ? `  (${at})` : ''));
    });
    this.page.on('pageerror', (e) => this.log('pageerror', String(e.stack || e)));
    this.page.on('requestfailed', (r) => this.log('requestfailed', `${r.url()} ${r.failure()?.errorText || ''}`));
    this.page.on('response', (r) => { if (r.status() >= 400) this.log('http', `${r.status()} ${r.url()}`); });

    await this.page.goto(url, { waitUntil: 'load' });
    await this.page.mouse.move(width / 2, height / 2);
    // 모듈 로딩·비동기 초기화가 끝나 게임 루프가 rAF를 걸 때까지 기다린다
    const started = await this.page.waitForFunction(() => window.__gp.pending() > 0, null, { timeout: 8000 }).then(() => true, () => false);

    let info;
    if (paused) info = await this.page.evaluate((n) => window.__gp.step({ frames: n }), warmupFrames);
    else await this.page.evaluate(() => window.__gp.resume());

    return {
      url, browser: this.channel, viewport: this.size,
      gameLoopDetected: started,
      paused, seed,
      title: await this.page.title(),
      gpu: await this.page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
      }),
      ...(info?.frameErrors ? { frameErrors: info.frameErrors } : {}),
      recentLogs: this.logs.slice(-10),
    };
  }

  log(type, text) {
    this.logs.push({ type, text: text.slice(0, 1000) });
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
  }

  need() {
    if (!this.page) throw new Error('no game is open: call game_open first');
    return this.page;
  }

  // 키·버튼은 진짜(trusted) 이벤트로, 시선은 합성 movementX/Y 로 넣는다
  async input(actions) {
    const page = this.need();
    const done = [];
    for (const a of actions) {
      switch (a.type) {
        case 'key':
          if (a.action === 'down') await page.keyboard.down(a.key);
          else if (a.action === 'up') await page.keyboard.up(a.key);
          else await page.keyboard.press(a.key);
          break;
        case 'text': await page.keyboard.type(a.text); break;
        case 'mouse': {
          const button = BUTTONS[a.button || 'left'];
          if (a.x !== undefined) await page.mouse.move(a.x, a.y);
          if (a.action === 'down') await page.mouse.down({ button });
          else if (a.action === 'up') await page.mouse.up({ button });
          else await page.mouse.click(a.x ?? this.size.width / 2, a.y ?? this.size.height / 2, { button });
          break;
        }
        case 'move': await page.mouse.move(a.x, a.y, { steps: a.steps || 1 }); break;
        case 'look': await page.evaluate(([dx, dy]) => window.__gp.look(dx, dy), [a.dx || 0, a.dy || 0]); break;
        case 'wheel': await page.mouse.wheel(a.dx || 0, a.dy || 0); break;
        case 'wait': await page.waitForTimeout(a.ms || 100); break;
        default: throw new Error(`unknown input type: ${a.type}`);
      }
      done.push(a.type + (a.action ? ':' + a.action : '') + (a.key ? ':' + a.key : '') + (a.button ? ':' + a.button : ''));
    }
    // 마이크로태스크로 처리되는 이벤트(포인터 락 변경 등)가 반영되게 한 번 양보한다
    await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
    return { done };
  }

  // 누르고 있을 키·버튼을 잡은 채로 프레임을 진행한다
  async step({ frames = 1, dt, hold = {}, look, watch = [], until, every = 1, release = true, samples } = {}) {
    const page = this.need();
    const keys = hold.keys || [];
    const buttons = hold.buttons || [];
    for (const k of keys) await page.keyboard.down(k);
    for (const b of buttons) await page.mouse.down({ button: BUTTONS[b] });
    let result;
    try {
      const nFrames = Math.round(num(frames, 1)), dtMs = num(dt, 1000 / 60);
      if (this.speed) await this.caption(`step ${nFrames} frames @ ${Math.round(1000 / dtMs)} fps` +
        (keys.length || buttons.length ? `   holding ${[...keys, ...buttons].join(' + ')}` : '') +
        (look ? `   look ${look.dx || 0},${look.dy || 0}/frame` : '') + (until ? `
until ${until}` : ''));
      result = await page.evaluate((o) => window.__gp.step(o), {
        speed: this.speed,
        frames: nFrames, dt: dtMs, lookDx: num(look?.dx, 0), lookDy: num(look?.dy, 0),
        watch, until, every: Math.max(1, Math.round(num(every, 1))), samples: Math.min(200, Math.max(2, Math.round(num(samples, 12)))),
      });
    } finally {
      if (release) {
        for (const b of buttons) await page.mouse.up({ button: BUTTONS[b] });
        for (const k of keys) await page.keyboard.up(k);
      }
    }
    return result;
  }

  async caption(text) {
    if (this.page) await this.page.evaluate((t) => window.__gp.caption(t), text).catch(() => {});
  }

  async screenshot({ scale = 0.6, quality = 70 } = {}) {
    const page = this.need();
    const buf = await page.screenshot({ type: 'jpeg', quality, scale: 'css' });
    if (scale >= 0.999) return buf.toString('base64');
    return this.resize(buf, scale, quality);
  }

  async resize(buf, scale, quality) {
    const page = this.need();
    return page.evaluate(async ([b64, s, q]) => {
      const img = new Image();
      img.src = 'data:image/jpeg;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', q / 100).split(',')[1];
    }, [buf.toString('base64'), scale, quality]);
  }

  // 프레임을 진행하면서 every 프레임마다 찍어 한 장의 격자 이미지로 합친다.
  // 에이전트가 움직임을 한 번에 볼 수 있게 하는 것이 목적이다.
  async filmstrip({ frames = 60, shots = 8, cols = 4, scale = 0.3, hold = {}, look, watch = [], dt } = {}) {
    const page = this.need();
    const every = Math.max(1, Math.floor(frames / shots));
    const tiles = [];
    const results = [];
    for (let i = 0; i < shots; i++) {
      const r = await this.step({ frames: every, dt, hold, look, watch, release: i === shots - 1 });
      results.push(r);
      const b64 = (await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64');
      tiles.push({ b64, label: `f${r.frame}` });
    }
    const sheet = await this.composeSheet(tiles, cols, scale);

    const last = results[results.length - 1];
    const summary = { framesRun: results.reduce((a, r) => a + r.framesRun, 0), frame: last.frame, gameTimeMs: last.gameTimeMs, tiles: tiles.map((t) => t.label) };
    const lastOf = (s) => (!s ? null : 'constant' in s ? s.constant : 'last' in s ? s.last : s.changes?.at(-1)?.[1] ?? null);
    if (watch.length) summary.watchAtEachTile = Object.fromEntries(watch.map((w) => [w, results.map((r) => lastOf(r.watch?.[w]))]));
    const errs = results.flatMap((r) => r.frameErrors || []);
    if (errs.length) summary.frameErrors = errs.slice(0, 5);
    return { sheet, summary };
  }

  // 합성은 페이지 안의 2D 캔버스로 한다 (이미지 라이브러리 의존성 없이)
  async composeSheet(tiles, cols, scale) {
    return this.page.evaluate(async ([tiles, cols, s]) => {
      const imgs = await Promise.all(tiles.map(async (t) => { const im = new Image(); im.src = 'data:image/jpeg;base64,' + t.b64; await im.decode(); return im; }));
      const w = Math.round(imgs[0].width * s), h = Math.round(imgs[0].height * s);
      const rows = Math.ceil(imgs.length / cols);
      const c = document.createElement('canvas');
      c.width = w * cols; c.height = h * rows;
      const g = c.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
      imgs.forEach((im, i) => {
        const x = (i % cols) * w, y = Math.floor(i / cols) * h;
        g.drawImage(im, x, y, w, h);
        g.fillStyle = 'rgba(0,0,0,.65)'; g.fillRect(x, y, 64, 20);
        g.fillStyle = '#fff'; g.font = '13px monospace'; g.fillText(tiles[i].label, x + 5, y + 15);
        g.strokeStyle = '#000'; g.strokeRect(x + .5, y + .5, w - 1, h - 1);
      });
      return c.toDataURL('image/jpeg', 0.75).split(',')[1];
    }, [tiles, cols, scale]);
  }

  // 반사 코드를 매 프레임 실행하며 진행한다. LLM은 느리게 코드를 짜고, 코드는 빠르게 조작한다.
  async control({ policy, frames = 600, dt, watch = [], until, every, samples, shots = 0, cols = 4, scale = 0.3, reset = false } = {}) {
    if (reset) { if (!this.lastOpen) throw new Error('no game was opened yet'); await this.open({ ...this.lastOpen }); }
    const page = this.need();
    const set = await page.evaluate(([c, d]) => window.__gp.setPolicy(c, d), [policy, num(dt, 1000 / 60)]);
    if (!set.ok) return { ok: false, error: set.error };
    const total = Math.round(num(frames, 600));
    const per = Math.ceil(total / Math.max(1, shots));
    const results = [], tiles = [];
    let done = 0, pol = null;
    try {
      while (done < total) {
        const n = Math.min(per, total - done);
        const r = await this.step({ frames: n, dt, watch, until, every, samples });
        results.push(r);
        done += r.framesRun;
        if (shots > 0) tiles.push({ b64: (await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64'), label: `f${r.frame}` });
        if (r.untilMet || r.framesRun < n) break; // until 충족 또는 반사 코드 에러
      }
    } finally {
      pol = await page.evaluate(() => window.__gp.clearPolicy());
    }
    const last = results[results.length - 1];
    const out = { ok: !pol?.error, framesRun: done, controlTimeMs: Math.round(done * num(dt, 1000 / 60)), frame: last.frame, gameTimeMs: last.gameTimeMs };
    if (until) out.untilMet = !!last.untilMet;
    if (pol?.error) out.policyError = pol.error;
    out.framesWithInput = pol?.framesWithInput;
    if (pol?.logs?.length) out.policyLog = pol.logs;
    if (pol?.mem && Object.keys(pol.mem).length) out.mem = pol.mem;
    if (watch.length) {
      if (results.length === 1) out.watch = last.watch;
      else {
        const lastOf = (x) => (!x ? null : 'constant' in x ? x.constant : 'last' in x ? x.last : x.changes?.at(-1)?.[1] ?? null);
        out.watchAtEachTile = Object.fromEntries(watch.map((w) => [w, results.map((r) => lastOf(r.watch?.[w]))]));
      }
    }
    const errs = results.flatMap((r) => r.frameErrors || []);
    if (errs.length) out.frameErrors = errs.slice(0, 5);
    if (tiles.length) out.tiles = tiles.map((t) => t.label);
    return { summary: out, sheet: tiles.length ? await this.composeSheet(tiles, cols, scale) : null };
  }

  // 식이면 값을, 문장이면 함수 본문으로 실행한다. 결과는 읽을 수 있는 크기로 줄인다.
  async eval(code, depth = 3) {
    const page = this.need();
    return page.evaluate(async ([code, depth]) => {
      let fn;
      try { fn = new Function(`return (async () => (${code}))();`); }
      catch { fn = new Function(`return (async () => { ${code} })();`); }
      try {
        const v = await fn();
        return { ok: true, value: window.__gp.snapshot(v, depth) };
      } catch (e) {
        // 스택에서 playwright 내부 프레임을 걷어낸다
        const stack = String((e && e.stack) || e).split('\n').filter((l) => !/UtilityScript|eval at evaluate|<anonymous>:\d+:\d+\)$/.test(l));
        return { ok: false, error: stack.join('\n').slice(0, 1500) };
      }
    }, [code, depth]);
  }

  // 시나리오 하나를 실행하고 결과식 값을 돌려준다. sweep을 주면 값마다 처음부터 다시 연 깨끗한 상태에서
  // 같은 시나리오를 돌린다. 문자열 안의 $이름 은 그 회차의 값으로 바뀐다.
  async run({ steps = [], result, sweep, reload } = {}) {
    if (!this.lastOpen) throw new Error('no game is open: call game_open first');
    const values = sweep ? sweep.values : [undefined];
    const fresh = reload ?? !!sweep;
    const rows = [];
    for (const v of values) {
      const sub = (x) => {
        if (!sweep) return x;
        const s = JSON.stringify(x).replace(new RegExp(`"\\$${sweep.name}"`, 'g'), JSON.stringify(v))
          .replace(new RegExp(`\\$${sweep.name}\\b`, 'g'), typeof v === 'string' ? v : JSON.stringify(v));
        return JSON.parse(s);
      };
      if (fresh) await this.open({ ...this.lastOpen });
      const row = sweep ? { [sweep.name]: v } : {};
      const notes = [];
      try {
        for (const st of sub(steps)) {
          if (st.input) await this.input(st.input);
          if (st.eval) { const r = await this.eval(st.eval); if (!r.ok) notes.push(`eval failed: ${r.error.split('\n')[0]}`); }
          if (st.step) {
            const r = await this.step(st.step);
            if (r.untilMet !== undefined) row.untilMet = r.untilMet;
            if (r.watch) row.watch = r.watch;
            if (r.frameErrors) notes.push(...r.frameErrors.map((e) => `frame ${e.frame}: ${String(e.error).split('\n')[0]}`));
            row.frame = r.frame;
          }
        }
        if (result) { const r = await this.eval(sub(result)); row.result = r.ok ? r.value : `ERR ${r.error.split('\n')[0]}`; }
      } catch (e) { notes.push(e.message); }
      if (notes.length) row.notes = notes.slice(0, 5);
      rows.push(row);
    }
    return sweep ? { runs: rows.length, freshStateEachRun: fresh, rows } : rows[0];
  }

  async setRunning(running) {
    const page = this.need();
    await page.evaluate((r) => (r ? window.__gp.resume() : window.__gp.pause()), running);
    return page.evaluate(() => ({ paused: window.__gp.paused, frame: window.__gp.frame }));
  }

  getLogs({ clear = false, types } = {}) {
    let out = this.logs;
    if (types?.length) out = out.filter((l) => types.includes(l.type));
    out = out.slice(-80);
    if (clear) this.logs = [];
    return out;
  }

  async closeGame() {
    if (this.ctx) await this.ctx.close().catch(() => {});
    if (this.server) this.server.close();
    this.ctx = this.page = this.server = null;
  }

  async close() {
    await this.closeGame();
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
  }
}
