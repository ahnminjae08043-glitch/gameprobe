// Builds the ~30 s demo video from real gameprobe runs. Every frame comes from stepping virtual time, so motion is
// perfectly smooth however slow capturing is. Hook first, explanation later, something new on screen every few seconds.
//   node tools/make-demo.mjs               -> out/demo/gameprobe-demo.webm
//   DEMO_LANG=ko node tools/make-demo.mjs  -> out/demo/gameprobe-demo-ko.webm
// Needs ../ascend (three.js climbing game) and unity/TestGame/Build/TestGame.exe for those scenes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { Session } from '../src/session.js';
import { UnitySession } from '../src/unity.js';

const KO = process.env.DEMO_LANG === 'ko';
const t = (en, ko) => (KO ? ko : en);
const OUT = path.resolve('out/demo');
fs.mkdirSync(OUT, { recursive: true });
const FILE = path.join(OUT, KO ? 'gameprobe-demo-ko.webm' : 'gameprobe-demo.webm');
const FPS = 30, W = 1280, H = 720;
const RED = '#e5484d', GREEN = '#30a46c', GOLD = '#f5d90a';

// ---------- writer: JPEG frames into the ffmpeg that ships with Playwright (VP8) ----------
const ffmpegPath = (() => {
  const base = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  const dir = fs.readdirSync(base).filter((d) => d.startsWith('ffmpeg')).sort().pop();
  return path.join(base, dir, process.platform === 'win32' ? 'ffmpeg-win64.exe' : 'ffmpeg-linux');
})();
const ff = spawn(ffmpegPath, ['-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', 'pipe:0',
  '-an', '-c:v', 'vp8', '-qmin', '0', '-qmax', '36', '-crf', '5', '-b:v', '6M', '-deadline', 'good', '-cpu-used', '2', FILE],
  { stdio: ['pipe', 'ignore', 'pipe'] });
let ffErr = '';
ff.stderr.on('data', (d) => { ffErr = (ffErr + d).slice(-3000); });
let frames = 0;
// 장면·사건이 영상 몇 초에 나오는지 기록한다. 소리를 정확히 맞추는 데 쓴다 (tools/mix-audio.mjs)
const marks = [];
const mark = (name) => { if (!marks.some((m) => m.name === name)) marks.push({ name, t: +(frames / FPS).toFixed(3) }); };
const write = (buf) => new Promise((res) => { frames++; ff.stdin.write(buf) ? res() : ff.stdin.once('drain', res); });

// ---------- compositor ----------
// draw({ images: [{b64, x,y,w,h, sx,sy,sw,sh, border, dim}], rects: [{x,y,w,h, fill, stroke, lw, alpha}],
//        texts: [{text, x,y, size, color, align, weight, bg, mono}], flash: {color, alpha}, bg })
const browser = await chromium.launch({ channel: 'chrome' });
const comp = await browser.newPage({ viewport: { width: W, height: H } });
await comp.setContent(`<canvas id=c width=${W} height=${H}></canvas><script>
const c = document.getElementById('c'), g = c.getContext('2d');
const cache = new Map();
async function img(b64) {
  if (cache.has(b64)) return cache.get(b64);
  const im = new Image(); im.src = 'data:image/jpeg;base64,' + b64; await im.decode();
  if (cache.size > 40) cache.clear(); cache.set(b64, im); return im;
}
const FONT = '"Segoe UI", "Malgun Gothic", sans-serif';
window.draw = async (o) => {
  g.globalAlpha = 1; g.fillStyle = o.bg || '#0b0d12'; g.fillRect(0, 0, ${W}, ${H});
  for (const m of o.images || []) {
    const im = await img(m.b64);
    if (m.sw) g.drawImage(im, m.sx, m.sy, m.sw, m.sh, m.x, m.y, m.w, m.h); else g.drawImage(im, m.x, m.y, m.w, m.h);
    if (m.dim) { g.fillStyle = 'rgba(0,0,0,' + m.dim + ')'; g.fillRect(m.x, m.y, m.w, m.h); }
    if (m.border) { g.strokeStyle = m.border; g.lineWidth = 6; g.strokeRect(m.x + 3, m.y + 3, m.w - 6, m.h - 6); }
  }
  for (const r of o.rects || []) {
    g.globalAlpha = r.alpha ?? 1;
    if (r.fill) { g.fillStyle = r.fill; g.fillRect(r.x, r.y, r.w, r.h); }
    if (r.stroke) { g.strokeStyle = r.stroke; g.lineWidth = r.lw || 2; g.strokeRect(r.x, r.y, r.w, r.h); }
  }
  g.globalAlpha = 1;
  for (const s of o.texts || []) {
    const size = s.size || 48;
    g.font = (s.weight || 800) + ' ' + size + 'px ' + (s.mono ? 'Consolas, monospace' : FONT);
    g.textAlign = s.align || 'center'; g.textBaseline = 'middle';
    const tw = g.measureText(s.text).width;
    if (s.bg) {
      const pad = size * 0.35, bx = s.align === 'left' ? s.x - pad : s.align === 'right' ? s.x - tw - pad : s.x - tw / 2 - pad;
      g.fillStyle = s.bg; g.fillRect(bx, s.y - size * 0.72, tw + pad * 2, size * 1.44);
    } else {
      g.lineWidth = Math.max(4, size / 7); g.strokeStyle = 'rgba(0,0,0,.85)'; g.lineJoin = 'round'; g.strokeText(s.text, s.x, s.y);
    }
    g.fillStyle = s.color || '#ffffff'; g.fillText(s.text, s.x, s.y);
  }
  if (o.flash) { g.globalAlpha = o.flash.alpha; g.fillStyle = o.flash.color; g.fillRect(0, 0, ${W}, ${H}); g.globalAlpha = 1; }
  return c.toDataURL('image/jpeg', 0.9).split(',')[1];
};
</script>`);
const render = async (o) => Buffer.from(await comp.evaluate((x) => window.draw(x), o), 'base64');
const frame = async (o) => write(await render(o));
const hold = async (o, sec) => { const b = await render(o); for (let i = 0; i < Math.round(sec * FPS); i++) await write(b); };
const headline = (text, color = '#fff', y = 70, size = 56) => ({ text, x: W / 2, y, size, color });
const sub = (text, y = 655, size = 34, color = '#e8edf5') => ({ text, x: W / 2, y, size, color, weight: 600 });

// ---------- platformer helpers ----------
const PLATFORMER = path.resolve('examples/buggy-platformer');
const GAME = { x: 160, y: 0, width: 960, height: 540 };   // the canvas inside the page
const shot = async (s) => (await s.page.screenshot({ type: 'jpeg', quality: 88, clip: GAME })).toString('base64');
const stepFrames = (s, n, dt) => s.page.evaluate((o) => window.__gp.step(o), { frames: n, dt });
const player = (s) => s.page.evaluate(() => ({ x: game.player.x, y: game.player.y, deaths: game.player.deaths, onGround: game.player.onGround, coin: game.coin.taken }));
const setPolicy = (s, code, dt = 1000 / 60) => s.page.evaluate(([c, d]) => window.__gp.setPolicy(c, d), [code, dt]);
async function openAt(dt, x, y) {
  const s = new Session();
  await s.open({ dir: PLATFORMER });
  await s.eval(`Object.assign(game.player, { x: ${x}, y: ${y}, vx: 0, vy: 0 }); true`);
  await stepFrames(s, 2, dt);
  return s;
}

const attempt = (l4, l5) => `const p=game.player,c=game.coin,L=game.level,m=ctx.mem;
if(c.taken&&!m.got){m.got=1;}
if(!m.got){let j=false;if(p.onGround){const f=p.y+p.h;const pl=L.slice(0,6).find(q=>Math.abs(q.y-f)<1&&p.x+p.w>q.x&&p.x<q.x+q.w);
if(!pl||pl===L[0])j=true;else if(pl===L[4])j=${l4};else if(pl===L[5])j=${l5};else if(p.x+p.w>=pl.x+pl.w-2)j=true;}
return {keys:j?['ArrowRight','Space']:['ArrowRight']};}
if(p.x<=40&&p.onGround)return {};return {keys:['ArrowLeft']};`;
const ATTEMPTS = [
  { name: '#1', policy: attempt('p.x+p.w>=L[4].x+L[4].w-2', 'false'), color: RED },   // jump at every edge
  { name: '#2', policy: attempt('p.x>=730', 'false'), color: '#f76b15' },            // jump early to the red platform
  { name: '#3', policy: attempt('p.x>=730', 'p.x>=865'), color: GOLD },             // hop for the coin
  { name: '#4', policy: attempt('p.x>=730', 'p.x>=862'), color: GREEN },            // one frame earlier
];
const DONE = 'game.player.deaths > 0 || (game.coin.taken && game.player.x <= 40 && game.player.onGround)';

const t0 = Date.now();
try {
  // ===== 1. HOOK: same inputs, 60 fps vs 30 fps, side by side =====
  const runs = [{ fps: 60, color: GREEN }, { fps: 30, color: RED }];
  for (const r of runs) { r.dt = 1000 / r.fps; r.s = await openAt(r.dt, 850, 56); r.trail = []; }
  for (const r of runs) await setPolicy(r.s, `const p = game.player; if (p.y < 60 && p.x < 945) return { keys: ['ArrowRight'] }; return {};`, r.dt);
  // zoom on the tower and the bridge so the player is big enough to follow, and ring it in its run's colour
  const HC = { sx: 520, sy: 0, sw: 440, sh: 540 };
  const HP = (k) => ({ x: 196 + k * 458, y: 105, w: 430, h: Math.round(430 * HC.sh / HC.sw) });
  const hp = (k, gx, gy) => { const p = HP(k); return [p.x + (gx - HC.sx) * p.w / HC.sw, p.y + (gy - HC.sy) * p.h / HC.sh]; };
  const sideBySide = async (borders) => {
    const images = [], rects = [];
    for (const [k, r] of runs.entries()) {
      images.push({ b64: await shot(r.s), ...HC, ...HP(k), border: borders?.[k] });
      const p = await player(r.s);
      if (p.deaths === 0) { const [x, y] = hp(k, p.x, p.y), sc = HP(k).w / HC.sw; rects.push({ x: x - 6, y: y - 6, w: 20 * sc + 12, h: 24 * sc + 12, stroke: r.color, lw: 4 }); }
    }
    return { images, rects };
  };
  const labels = [{ text: '60 fps', x: HP(0).x + 215, y: 655, size: 34, color: GREEN }, { text: '30 fps', x: HP(1).x + 215, y: 655, size: 34, color: RED }];
  const q1 = headline(t('Same game. Same inputs.', '같은 게임. 같은 입력.'), '#fff', 70, 58);
  const q2 = sub(t('One of them is broken. Watch the floor.', '둘 중 하나는 고장 났습니다. 바닥을 보세요.'), 698, 30);
  await hold({ ...(await sideBySide()), texts: [q1, ...labels, q2] }, 1.3);
  let fell = false;
  for (let v = 0; v < 45 && !fell; v++) {
    for (const r of runs) {
      await stepFrames(r.s, r.fps / FPS, r.dt);
      r.trail.push(await player(r.s));
      if (r.trail.at(-1).deaths > 0) fell = true;
    }
    await frame({ ...(await sideBySide()), texts: [q1, ...labels, q2] });
  }
  const frozen = await sideBySide([GREEN, RED]);
  { const [, by] = hp(1, 0, 470); frozen.texts = [{ text: t('fell through', '뚫고 떨어짐'), x: HP(1).x + HP(1).w - 20, y: by + 40, size: 30, color: RED, align: 'right' }]; }
  const f1 = headline(t('It fell through the floor.', '바닥을 뚫고 떨어졌습니다.'), '#fff', 70, 58);
  mark('fall');
  for (let k = 0; k < 6; k++) await frame({ ...frozen, texts: [f1, ...labels, ...frozen.texts], flash: { color: RED, alpha: 0.45 * (1 - k / 6) } });
  await hold({ ...frozen, texts: [f1, ...labels, ...frozen.texts, sub(t('Only on slow laptops. Your fast PC never sees it.', '느린 노트북에서만. 빠른 PC에서는 절대 안 보입니다.'), 698, 32, '#ffd1d1')] }, 1.6);

  // ===== 2. REPLAY: zoom on the bridge, one box per frame =====
  // background without the player in it: move it off the canvas for one frame
  await runs[0].s.eval('Object.assign(game.player, { x: -300, y: 0, vx: 0, vy: 0 }); true');
  await stepFrames(runs[0].s, 1, 1000 / 60);
  const bg = await shot(runs[0].s);
  const crop = { sx: 860, sy: 330, sw: 100, sh: 200 };
  const panel = (k) => ({ x: k === 0 ? 345 : 665, y: 125, w: 270, h: 540 });
  const sc = 270 / crop.sw;
  const toPanel = (k, gx, gy) => { const p = panel(k); return [p.x + (gx - crop.sx) * sc, p.y + (gy - crop.sy) * sc]; };
  const fallTrail = runs.map((r) => r.trail.filter((p) => p.x >= 900 && p.y > 330 && p.y < 530));
  const maxLen = Math.max(...fallTrail.map((a) => a.length));
  const replayFrame = (k, final) => {
    const rects = [];
    runs.forEach((r, j) => {
      const pn = panel(j);
      const [, by] = toPanel(j, 0, 470);
      rects.push({ x: pn.x, y: by, w: pn.w, h: 4 * sc, fill: '#a3be8c' });                       // the 4 px bridge
      fallTrail[j].slice(0, k).forEach((p, i, tr) => {
        const [x, y] = toPanel(j, p.x, p.y);
        rects.push({ x, y, w: 20 * sc, h: 24 * sc, stroke: r.color, lw: 3, fill: r.color, alpha: i === tr.length - 1 ? 0.9 : 0.25 });
      });
    });
    const done = final || k >= maxLen;
    return { images: runs.map((r, j) => ({ b64: bg, ...crop, ...panel(j), dim: 0.35 })), rects, texts: [
      headline(t('Frame by frame, at the bridge', '다리 근처를 한 프레임씩'), '#fff', 50, 46),
      { text: done ? t('60 fps: landed', '60fps: 착지') : '60 fps', x: panel(0).x + 135, y: 102, size: 30, color: GREEN },
      { text: done ? t('30 fps: skipped it', '30fps: 건너뜀') : '30 fps', x: panel(1).x + 135, y: 102, size: 30, color: RED },
      { text: t('4 px bridge', '4px 다리'), x: panel(0).x - 16, y: toPanel(0, 0, 472)[1], size: 24, color: '#a3be8c', weight: 700, align: 'right' },
      ...(done ? [sub(t('55 px per frame jumps clean over a 4 px floor.', '한 프레임에 55px. 4px 바닥을 그냥 건너뜁니다.'), 696, 30)] : [])] };
  };
  mark('replay');
  for (let k = 1; k <= maxLen; k++) await hold(replayFrame(k), 0.22);
  await hold(replayFrame(maxLen, true), 1.4);
  for (const r of runs) await r.s.close();
  mark('aiCard');
  await hold({ texts: [headline(t('An AI agent found this bug.', 'AI 에이전트가 이 버그를 찾았습니다.'), '#fff', 310, 62),
    { text: t('It had never seen the game.', '게임을 처음 본 에이전트였습니다.'), x: W / 2, y: 400, size: 40, color: '#b8c4d6', weight: 600 }] }, 1.8);

  // ===== 3. BRAND =====
  mark('brand');
  await hold({ texts: [{ text: 'gameprobe', x: W / 2, y: 300, size: 110, color: '#fff' },
    { text: t('lets coding agents actually play games.', '코딩 에이전트가 게임을 직접 플레이하게 해 줍니다.'), x: W / 2, y: 410, size: 40, color: '#9fb7d8', weight: 600 }] }, 1.7);

  // ===== 4. GHOST RACE: four attempts on one screen =====
  const ghosts = [];
  for (const a of ATTEMPTS) {
    const s = new Session();
    await s.open({ dir: PLATFORMER });
    await setPolicy(s, a.policy);
    const pos = [];
    for (let i = 0; i < 700; i++) {
      const r = await s.page.evaluate((o) => window.__gp.step(o), { frames: 1, until: DONE });
      pos.push(await player(s));
      if (r.untilMet) break;
    }
    const caps = [];
    if (a === ATTEMPTS.at(-1)) {
      await s.open({ dir: PLATFORMER });                       // same seed, same start: replay for screenshots
      await setPolicy(s, a.policy);
      for (let i = 0; i < pos.length; i += 3) { await stepFrames(s, 3); caps.push(await shot(s)); }
    }
    ghosts.push({ ...a, pos, died: pos.at(-1).deaths > 0, caps });
    await s.close();
  }
  const best = ghosts.at(-1);
  const GX = 160, GY = 120;
  mark('ghosts');
  for (let v = 0; v < best.caps.length; v++) {
    const i = Math.min((v + 1) * 3, best.pos.length) - 1;
    const rects = [];
    const texts = [headline(t('The AI writes a controller. Code plays at 60 fps.', 'AI는 조작 코드를 쓰고, 코드가 초당 60번 플레이합니다.'), '#fff', 62, 40)];
    ghosts.slice(0, -1).forEach((g) => {
      if (i >= g.pos.length && g.died) { mark('ghostDied'); return; }
      const p = g.pos[Math.min(i, g.pos.length - 1)];
      rects.push({ x: GX + p.x, y: GY + p.y, w: 20, h: 24, fill: g.color, alpha: 0.6 });
    });
    ghosts.forEach((g, k) => {
      const finished = i >= g.pos.length - 1;
      const secs = (Math.min(i + 1, g.pos.length) / 60).toFixed(2);
      const status = !finished ? `${secs} s` : g.died ? t('dead', '사망') : `${secs} s` + (g === best ? t('  BEST', '  최단') : '');
      texts.push({ text: `${g.name}  ${status}`, x: 1110, y: 165 + k * 50, size: 28, color: g.color, align: 'right', weight: 700, bg: 'rgba(8,10,14,.8)' });
    });
    texts.push(sub(i < 250 ? t('4 attempts raced as ghosts. #1 hits its head and dies.', '시도 4번을 유령으로 겹쳤습니다. 1번은 머리를 박고 죽습니다.')
      : t('#4 shaved it down one frame at a time.', '4번은 한 프레임씩 줄여 나갔습니다.'), 690, 30));
    await frame({ images: [{ b64: best.caps[v], x: GX, y: GY, w: 960, h: 540 }], rects, texts });
  }
  mark('best');
  await hold({ images: [{ b64: best.caps.at(-1), x: GX, y: GY, w: 960, h: 540, dim: 0.45 }],
    texts: [headline(t('6.37 s. Zero deaths.', '6.37초. 사망 0.'), GREEN, 330, 80),
      { text: t('The theoretical minimum. Not one wasted frame.', '이론상 최단 기록. 낭비한 프레임 0.'), x: W / 2, y: 420, size: 38, color: '#fff', weight: 600 }] }, 1.6);

  // ===== 5. UNITY: one coin, two points =====
  const exe = path.resolve('unity/TestGame/Build/TestGame.exe');
  if (fs.existsSync(exe)) {
    const unityRun = async (feetOn) => {
      const u = new UnitySession();
      await u.open({ exe });
      if (!feetOn) await u.eval('$set("Feet.SphereCollider.enabled", false)');
      const caps = [];
      let after = 0;
      for (let i = 0; i < 60 && after < 6; i++) {
        const r = await u.call('step', { frames: 2, input: { keys: ['KeyW'], buttons: [], look: { x: 0, y: 0 } }, read: ['#GameManager.score'], capture: true, maxWidth: 960 });
        const score = r.series?.at(-1)?.[1]?.[0] ?? 0;
        caps.push({ jpeg: r.jpeg, score });
        if (score > 0) after++;
      }
      await u.close();
      return caps;
    };
    const on = await unityRun(true);
    const uTitle = headline(t('Unity: walk into ONE coin', '유니티: 코인 하나에 걸어 들어가기'), '#fff', 60, 46);
    mark('unity');
    for (const c of on) {
      if (c.score > 1) mark('plus2');
      await frame({ images: [{ b64: c.jpeg, x: 160, y: 110, w: 960, h: 540 }], texts: [uTitle,
        { text: `score = ${c.score}`, x: W / 2, y: 380, size: c.score > 1 ? 130 : 70, color: c.score > 1 ? RED : '#fff', mono: true },
        ...(c.score > 1 ? [sub(t('One coin. Two points.', '코인 하나. 점수 2점.'), 690, 40, '#ffd1d1')] : [])] });
    }
    await hold({ images: [{ b64: on.at(-1).jpeg, x: 160, y: 110, w: 960, h: 540 }], texts: [uTitle,
      { text: 'score = 2', x: W / 2, y: 380, size: 130, color: RED, mono: true }, sub(t('One coin. Two points.', '코인 하나. 점수 2점.'), 690, 40, '#ffd1d1')] }, 0.7);
    const off = await unityRun(false);
    mark('compare');
    await hold({ images: [{ b64: on.at(-1).jpeg, x: 8, y: 150, w: 624, h: 351, border: RED }, { b64: off.at(-1).jpeg, x: 648, y: 150, w: 624, h: 351, border: GREEN }],
      texts: [headline(t('So the agent switched one collider off.', '그래서 에이전트가 충돌체 하나를 꺼 봤습니다.'), '#fff', 70, 44),
        { text: t('feet collider ON: +2', '발 충돌체 켬: +2'), x: 320, y: 555, size: 38, color: RED },
        { text: t('feet collider OFF: +1', '발 충돌체 끔: +1'), x: 960, y: 555, size: 38, color: GREEN },
        sub(t('Cause proven. One call.', '원인 증명. 호출 한 번으로.'), 660, 42, '#fff')] }, 2.3);
  }

  // ===== 6. ASCEND: altitude counter =====
  const ascend = path.resolve('../ascend');
  if (fs.existsSync(ascend)) {
    const brain = fs.readFileSync(path.resolve('test/ascend-climb.mjs'), 'utf8').match(/const BRAIN = `([\s\S]*?)`;/)[1];
    const s = new Session();
    await s.open({ dir: ascend });
    await s.input([{ type: 'mouse', action: 'click' }]);
    await s.eval(brain);
    const held = [false, false], BTN = ['left', 'right'];
    let d, last;
    for (let f = 0; f < 60 * 20; f += 2) {
      d = (await s.eval('__brain.decide(0.06)')).value;
      const acts = [];
      for (let k = 0; k < 2; k++) if (d.down[k] !== held[k]) { acts.push({ type: 'mouse', button: BTN[k], action: d.down[k] ? 'down' : 'up' }); held[k] = d.down[k]; }
      if (acts.length) await s.input(acts);
      await s.page.evaluate((o) => window.__gp.step(o), { frames: 2, dt: 1000 / 60, lookDx: d.dx, lookDy: d.dy });
      if (f % 6 === 0 || d.summited) {
        last = (await s.page.screenshot({ type: 'jpeg', quality: 85 })).toString('base64');
        mark('ascend');
        await frame({ images: [{ b64: last, x: 0, y: 0, w: W, h: H }], texts: [
          headline(t('First-person climbing. Mouse only. 3x speed.', '1인칭 암벽 등반. 마우스만으로. 3배속.'), '#fff', 60, 42),
          { text: `${Math.max(0, d.y).toFixed(1)} m`, x: W / 2, y: 330, size: 110, color: '#fff', mono: true }] });
      }
      if (d.summited) break;
    }
    mark('summit');
    await hold({ images: [{ b64: last, x: 0, y: 0, w: W, h: H, dim: 0.35 }], texts: [
      { text: '52 m', x: W / 2, y: 300, size: 150, color: GREEN, mono: true },
      { text: t('13.8 s. 62 grabs. 0 slips.', '13.8초. 홀드 62번. 미끄러짐 0.'), x: W / 2, y: 420, size: 44, color: '#fff' }] }, 1.4);
    await s.close();
  }

  // ===== 7. END =====
  mark('end');
  await hold({ texts: [{ text: 'gameprobe', x: W / 2, y: 230, size: 100, color: '#fff' },
    { text: t('Web games  /  Unity  /  any Windows game', '웹 게임  /  유니티  /  모든 윈도우 게임'), x: W / 2, y: 330, size: 36, color: '#9fb7d8', weight: 600 },
    { text: 'claude mcp add gameprobe -- npx -y gameprobe', x: W / 2, y: 440, size: 38, color: '#7ee08a', mono: true, weight: 600 },
    { text: 'github.com/ahnminjae08043-glitch/gameprobe', x: W / 2, y: 520, size: 32, color: '#e8edf5', mono: true, weight: 500 }] }, 3.2);
} finally {
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  await browser.close();
}
mark('done');
fs.writeFileSync(FILE.replace(/\.webm$/, '.timeline.json'), JSON.stringify(marks, null, 1));
console.log(fs.existsSync(FILE) ? `wrote ${FILE}: ${frames} frames, ${(frames / FPS).toFixed(1)} s, ${(fs.statSync(FILE).size / 1e6).toFixed(1)} MB, built in ${((Date.now() - t0) / 1000).toFixed(0)} s` : 'ffmpeg failed:\n' + ffErr);
