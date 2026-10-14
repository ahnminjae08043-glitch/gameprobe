// Builds the demo video from real gameprobe runs. Every frame is captured by stepping virtual time one frame at a
// time, so the video is perfectly smooth no matter how slow capturing is.
//   node tools/make-demo.mjs            -> out/demo/gameprobe-demo.webm
// Needs: ../ascend (three.js climbing game) and unity/TestGame/Build/TestGame.exe for those scenes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { Session } from '../src/session.js';
import { UnitySession } from '../src/unity.js';

const OUT = path.resolve('out/demo');
// DEMO_LANG=ko 로 자막을 한국어로
const KO = process.env.DEMO_LANG === 'ko';
const t = (en, ko) => (KO ? ko : en);
fs.mkdirSync(OUT, { recursive: true });
const FPS = 30, W = 1280, H = 720;

// ---------- video writer: JPEG frames piped into the ffmpeg that ships with Playwright (VP8 only) ----------
const ffmpegPath = (() => {
  const base = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  const dir = fs.readdirSync(base).filter((d) => d.startsWith('ffmpeg')).sort().pop();
  return path.join(base, dir, process.platform === 'win32' ? 'ffmpeg-win64.exe' : 'ffmpeg-linux');
})();
const ff = spawn(ffmpegPath, ['-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', 'pipe:0',
  '-an', '-c:v', 'vp8', '-qmin', '0', '-qmax', '40', '-crf', '6', '-b:v', '5M', '-deadline', 'good', '-cpu-used', '2',
  path.join(OUT, KO ? 'gameprobe-demo-ko.webm' : 'gameprobe-demo.webm')], { stdio: ['pipe', 'ignore', 'pipe'] });
let ffErr = '';
ff.stderr.on('data', (d) => { ffErr += d; if (ffErr.length > 4000) ffErr = ffErr.slice(-4000); });
let frameCount = 0;
const write = (jpeg) => new Promise((res) => { frameCount++; ff.stdin.write(jpeg) ? res() : ff.stdin.once('drain', res); });

// ---------- compositor: one page that frames every image the same way ----------
const browser = await chromium.launch({ channel: 'chrome' });
const comp = await browser.newPage({ viewport: { width: W, height: H } });
await comp.setContent(`<canvas id=c width=${W} height=${H}></canvas><script>
const c = document.getElementById('c'), g = c.getContext('2d');
const cache = new Map();
async function img(b64) { if (!b64) return null; const im = new Image(); im.src = 'data:image/jpeg;base64,' + b64; await im.decode(); return im; }
window.draw = async ({ b64, title, caption, badge, card }) => {
  g.fillStyle = '#0b0d12'; g.fillRect(0, 0, ${W}, ${H});
  if (card) {
    g.textAlign = 'center'; g.fillStyle = '#e9eef7';
    g.font = '600 76px Segoe UI, Malgun Gothic, sans-serif'; g.fillText(card.big, ${W / 2}, ${H / 2 - 20});
    g.font = '30px Segoe UI, Malgun Gothic, sans-serif'; g.fillStyle = '#9fb0c8';
    (card.small || []).forEach((l, i) => g.fillText(l, ${W / 2}, (${H / 2 + 50} + i * 44)));
    if (card.mono) { g.font = '34px Consolas, monospace'; g.fillStyle = '#7ee08a'; g.fillText(card.mono, ${W / 2}, (${H / 2 + 60} + (card.small || []).length * 44)); }
  } else {
    const im = await img(b64);
    if (im) { const s = Math.min(${W} / im.width, ${H} / im.height); const w = im.width * s, h = im.height * s; g.drawImage(im, (${W} - w) / 2, (${H} - h) / 2, w, h); }
  }
  g.textAlign = 'left';
  if (title) { g.fillStyle = 'rgba(8,10,14,.78)'; g.fillRect(0, 0, ${W}, 52); g.fillStyle = '#ffffff'; g.font = '600 26px Segoe UI, Malgun Gothic, sans-serif'; g.fillText(title, 22, 35); }
  if (badge) { g.font = '600 24px Consolas, monospace'; const tw = g.measureText(badge.text).width; g.fillStyle = badge.color || '#2f7d45'; g.fillRect(${W} - tw - 44, 64, tw + 28, 40); g.fillStyle = '#fff'; g.fillText(badge.text, ${W} - tw - 30, 92); }
  if (caption) {
    g.font = '26px Segoe UI, Malgun Gothic, sans-serif'; const lines = caption.split('\\n');
    const bh = 22 + lines.length * 36; g.fillStyle = 'rgba(8,10,14,.82)'; g.fillRect(0, ${H} - bh, ${W}, bh);
    g.fillStyle = '#eef3fb'; lines.forEach((l, i) => g.fillText(l, 22, ${H} - bh + 42 + i * 36));
  }
  return c.toDataURL('image/jpeg', 0.9).split(',')[1];
};
</script>`);
const frame = async (opts) => write(Buffer.from(await comp.evaluate((o) => window.draw(o), opts), 'base64'));
const hold = async (opts, seconds) => { const b = Buffer.from(await comp.evaluate((o) => window.draw(o), opts), 'base64'); for (let i = 0; i < seconds * FPS; i++) await write(b); };

// ---------- web helpers: run a policy one frame at a time and grab every Nth frame ----------
async function webRun(s, { policy, frames, dt = 1000 / 60, every = 2, until, title, caption, badge }) {
  await s.page.evaluate(([c, d]) => window.__gp.setPolicy(c, d), [policy, dt]);
  let met = false;
  for (let i = 0; i < frames && !met; i++) {
    const r = await s.page.evaluate((o) => window.__gp.step(o), { frames: 1, dt, until });
    met = !!r.untilMet;
    if (i % every === 0 || met) {
      const b64 = (await s.page.screenshot({ type: 'jpeg', quality: 85 })).toString('base64');
      const info = await s.page.evaluate(() => ({ p: { ...game.player }, coin: game.coin.taken, t: performance.now() }));
      await frame({ b64, title, caption: typeof caption === 'function' ? caption(info, i) : caption, badge: typeof badge === 'function' ? badge(info, i) : badge });
    }
  }
  await s.page.evaluate(() => window.__gp.clearPolicy());
}

const PLATFORMER = path.resolve('examples/buggy-platformer');
// Climb to the tower like the route found earlier, then walk off the right edge onto the thin bridge.
const toTowerThenDrop = `
const p = game.player, m = ctx.mem, P = [[120,420],[300,340],[480,260],[660,180],[820,80]];
m.k = m.k || 0; m.phase = m.phase || 'walk';
if (m.k >= P.length) { if (p.onGround && p.y < 100) return { keys: ['ArrowRight'] }; return {}; }
const [px] = P[m.k];
if (m.phase === 'walk') { if (p.x >= px - 60 && p.onGround) { m.phase = 'air'; return { keys: ['ArrowRight', 'Space'] }; } return { keys: ['ArrowRight'] }; }
if (m.phase === 'air') { if (p.x >= px + 30 || p.onGround) m.phase = 'fall'; else return { keys: ['ArrowRight'] }; }
if (m.phase === 'fall') { if (p.onGround) { m.k++; m.phase = 'walk'; } return {}; }`;

// The blind agent's first idea: jump at the right edge of every platform.
const attempt1 = `
const p = game.player, L = game.level;
let jump = false;
if (p.onGround) { const f = p.y + p.h; const pl = L.slice(0, 6).find(q => Math.abs(q.y - f) < 1 && p.x + p.w > q.x && p.x < q.x + q.w);
  if (!pl || pl === L[0]) jump = true; else if (p.x + p.w >= pl.x + pl.w - 2) jump = true; }
return { keys: jump ? ['ArrowRight', 'Space'] : ['ArrowRight'] };`;
// Its final controller (attempt 4), unchanged.
const attempt4 = `const p=game.player,c=game.coin,L=game.level,m=ctx.mem;
if(c.taken&&!m.got){m.got=1;}
if(!m.got){let j=false;if(p.onGround){const f=p.y+p.h;const pl=L.slice(0,6).find(q=>Math.abs(q.y-f)<1&&p.x+p.w>q.x&&p.x<q.x+q.w);
if(!pl||pl===L[0])j=true;else if(pl===L[4])j=p.x>=730;else if(pl===L[5])j=p.x>=862;else if(p.x+p.w>=pl.x+pl.w-2)j=true;}
return {keys:j?['ArrowRight','Space']:['ArrowRight']};}
if(p.x<=40&&p.onGround)return {};return {keys:['ArrowLeft']};`;

const t0 = Date.now();
try {
  // ---- 1. title
  await hold({ card: { big: 'gameprobe', small: [t('Let your coding agent actually play the game it just wrote.', '코딩 에이전트가 방금 만든 게임을 직접 플레이하게 하세요.')] } }, 3);

  // ---- 2. the slow-laptop bug
  await hold({ card: { big: t('Bugs only slow machines see', '느린 PC에서만 생기는 버그'), small: [t('Same inputs. Only the frame rate changes.', '입력은 똑같고, 프레임레이트만 다릅니다.')] } }, 2.5);
  for (const [fps, every, label, color] of [[60, 2, '60 fps', '#2f7d45'], [30, 1, '30 fps', '#a8323e']]) {
    const s = new Session();
    await s.open({ dir: PLATFORMER });
    const dt = 1000 / fps;
    await webRun(s, {
      policy: toTowerThenDrop, frames: fps * 9, dt, every, until: 'game.player.deaths > 0 || (game.player.onGround && game.player.y > 400 && game.player.x > 600)',
      title: t('Same run, two frame rates', '같은 플레이, 두 가지 프레임레이트'), badge: { text: label, color },
      caption: (i) => {
        const p = i.p; const perFrame = Math.round(Math.abs(p.vy) * dt / 1000);
        if (p.deaths > 0) return t(`${label}: fell straight through the 4 px bridge.\nFalling ${Math.round(1650 * dt / 1000)} px per frame skips the 28 px collision window.`, `${label}: 4px 두께 다리를 그대로 뚫고 떨어짐.\n한 프레임에 ${Math.round(1650 * dt / 1000)}px씩 떨어져서 28px 판정 범위를 건너뜀.`);
        if (p.onGround && p.y > 400) return t(`${label}: landed on the bridge.\nFalling ${Math.round(1650 * dt / 1000)} px per frame stays inside the 28 px collision window.`, `${label}: 다리에 정상 착지.\n한 프레임에 ${Math.round(1650 * dt / 1000)}px씩 떨어져서 28px 판정 범위 안에 걸림.`);
        return t(`virtual time: ${fps} fps, every frame stepped by gameprobe\nfall speed ${perFrame} px / frame`, `가상 시간 ${fps}fps, gameprobe가 한 프레임씩 진행\n낙하 속도 프레임당 ${perFrame}px`);
      },
    });
    const last = (await s.page.screenshot({ type: 'jpeg', quality: 85 })).toString('base64');
    const died = (await s.eval('game.player.deaths')).value > 0;
    await hold({ b64: last, title: t('Same run, two frame rates', '같은 플레이, 두 가지 프레임레이트'), badge: { text: label, color },
      caption: died ? t(`${label}: FELL THROUGH. Reproduces every time, so it can be fixed and re-checked.`, `${label}: 관통. 매번 똑같이 재현되니 고치고 다시 확인할 수 있습니다.`) : t(`${label}: landed. A fast machine never sees the bug.`, `${label}: 착지. 빠른 PC에서는 이 버그가 절대 안 보입니다.`) }, 2);
    await s.close();
  }

  // ---- 3. coach and hands
  await hold({ card: { big: t('The agent coaches. Code plays.', '에이전트는 코치, 코드는 손'), small: [t('An LLM needs seconds per decision. Its controller runs every frame.', 'LLM은 판단에 몇 초가 걸리지만, 조작 코드는 매 프레임 실행됩니다.'), t('Blind agent, never saw the game: get the coin, come home, fast.', '게임을 처음 보는 에이전트: 코인 먹고, 출발점으로, 최대한 빨리.')] } }, 3.5);
  for (const [policy, title, frames] of [[attempt1, t('Attempt 1: jump at every platform edge', '1차 시도: 발판 끝마다 점프'), 300], [attempt4, t('Attempt 4: the agent tuned it frame by frame', '4차 시도: 에이전트가 한 프레임씩 다듬음'), 420]]) {
    const s = new Session();
    await s.open({ dir: PLATFORMER });
    let startT = null;
    await webRun(s, {
      policy, frames, every: 2, until: 'game.player.deaths > 0 || (game.coin.taken && game.player.x <= 40 && game.player.onGround)', title,
      badge: (i) => { startT ??= i.t; return { text: `${((i.t - startT) / 1000).toFixed(2)} s`, color: '#2b4f86' }; },
      caption: (i) => i.p.deaths > 0 ? t('Hit its head under the red platform and died. The agent read why in its controller log.', '빨간 발판 아랫면에 머리를 박고 사망. 에이전트는 조작 코드 로그에서 원인을 읽었습니다.')
        : i.coin ? t('Coin taken. Heading home.', '코인 획득. 출발점으로 복귀 중.') : t('gameprobe runs the controller inside the game, 60 times a second.', 'gameprobe가 조작 코드를 게임 안에서 초당 60번 실행합니다.'),
    });
    const last = (await s.page.screenshot({ type: 'jpeg', quality: 85 })).toString('base64');
    const { value: [deaths, coin] } = await s.eval('[game.player.deaths, game.coin.taken]');
    await hold({ b64: last, title, caption: deaths ? t('Failed. Fix the code, rerun from the identical state.', '실패. 코드를 고쳐 똑같은 상태에서 다시 돌립니다.') : t('Coin and home in 6.37 s, zero deaths.\nThe theoretical minimum: 382 frames, none wasted. 5 attempts in total.', '코인 획득 후 귀환까지 6.37초, 사망 0.\n이론상 최단 기록: 382프레임, 낭비 0. 총 5번 시도.') }, 2.5);
    await s.close();
  }

  // ---- 4. Unity
  const exe = path.resolve('unity/TestGame/Build/TestGame.exe');
  if (fs.existsSync(exe)) {
    await hold({ card: { big: t('Unity too', '유니티도 됩니다'), small: [t('Add the package. Every value is readable by path. Frames are exact.', '패키지만 추가하면 모든 값을 경로로 읽고, 프레임을 정확히 제어합니다.')] } }, 2.5);
    const u = new UnitySession();
    await u.open({ exe });
    let score = 0;
    for (let i = 0; i < 75; i++) {
      const r = await u.call('step', { frames: 2, input: { keys: ['KeyW'], buttons: [], look: { x: 0, y: 0 } }, read: ['#GameManager.score'], capture: true, maxWidth: W });
      score = r.series?.at(-1)?.[1]?.[0] ?? score;
      await frame({ b64: r.jpeg, title: t('Unity: walking into one coin', '유니티: 코인 하나에 걸어 들어가기'), badge: { text: `#GameManager.score = ${score}`, color: score > 1 ? '#a8323e' : '#2b4f86' },
        caption: score > 1 ? t('One coin, score +2. Body and feet colliders both triggered it.\nThe agent proved it by turning the feet collider off: +1.', '코인 하나에 점수 +2. 몸통과 발 충돌체가 둘 다 반응했습니다.\n에이전트는 발 충돌체를 끄면 +1이 되는 것으로 원인을 증명했습니다.') : t('watch: "#GameManager.score"', '관찰 중: "#GameManager.score"') });
    }
    await u.close();
  }

  // ---- 5. ASCEND
  const ascend = path.resolve('../ascend');
  if (fs.existsSync(ascend)) {
    await hold({ card: { big: t('Human inputs, human speed', '사람과 같은 입력, 사람 속도'), small: [t('First-person cliff climbing: mouse buttons to grab, mouse movement to pull.', '1인칭 절벽 등반: 마우스 버튼으로 잡고, 마우스를 훑어 몸을 끌어올립니다.')] } }, 2.5);
    const brain = fs.readFileSync(path.resolve('test/ascend-climb.mjs'), 'utf8').match(/const BRAIN = `([\s\S]*?)`;/)[1];
    const s = new Session();
    await s.open({ dir: ascend });
    await s.input([{ type: 'mouse', action: 'click' }]);
    await s.eval(brain);
    const held = [false, false], BTN = ['left', 'right'];
    for (let f = 0; f < 60 * 20; f += 2) {
      const d = (await s.eval('__brain.decide(0.06)')).value;
      const acts = [];
      for (let k = 0; k < 2; k++) if (d.down[k] !== held[k]) { acts.push({ type: 'mouse', button: BTN[k], action: d.down[k] ? 'down' : 'up' }); held[k] = d.down[k]; }
      if (acts.length) await s.input(acts);
      await s.page.evaluate((o) => window.__gp.step(o), { frames: 2, dt: 1000 / 60, lookDx: d.dx, lookDy: d.dy, speed: 0 });
      if (f % 4 === 0 || d.summited) {
        const b64 = (await s.page.screenshot({ type: 'jpeg', quality: 85 })).toString('base64');
        await frame({ b64, title: t('ASCEND (three.js): 52 m cliff, 2x speed', 'ASCEND (three.js): 52m 절벽, 2배속'), badge: { text: `${d.y.toFixed(1)} m`, color: '#2b4f86' },
          caption: d.summited ? t('Summit in 13.8 s game time. 62 grabs, 0 slips, 0 falls.', '게임 시간 13.8초에 정상 도착. 홀드 62번, 미끄러짐 0, 추락 0.') : t('Real mouse buttons, mouse movement and W/S keys, decided every 2 frames.', '실제 마우스 버튼, 마우스 이동, W/S 키. 2프레임마다 판단.') });
      }
      if (d.summited) break;
    }
    await s.close();
  }

  // ---- 6. end
  await hold({ card: { big: 'gameprobe', small: [t('Web games, Unity, and any Windows game.', '웹 게임, 유니티, 그리고 모든 윈도우 게임.'), t('MCP server for Claude Code, Codex, Cursor and friends.', 'Claude Code, Codex, Cursor 등에서 쓰는 MCP 서버')], mono: 'claude mcp add gameprobe -- npx -y gameprobe' } }, 4);
} finally {
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  await browser.close();
}
const file = path.join(OUT, KO ? 'gameprobe-demo-ko.webm' : 'gameprobe-demo.webm');
console.log(fs.existsSync(file) ? `wrote ${file}: ${frameCount} frames, ${(frameCount / FPS).toFixed(1)} s, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB, built in ${((Date.now() - t0) / 1000).toFixed(0)} s` : 'ffmpeg failed:\n' + ffErr);
