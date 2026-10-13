// ASCEND 완등 시연. 판단은 게임 상태를 읽어서 하지만(ASCEND tools/bot.js 의 로직),
// 조작은 전부 gameprobe 입력 경로로 넣는다: 진짜 마우스 버튼, movementX/Y 시선, 진짜 W/S 키.
//   node test/ascend-climb.mjs           헤드리스로 빠르게
//   VISIBLE=1 node test/ascend-climb.mjs 창을 띄워 실제 속도로
import path from 'node:path';
import { Session } from '../src/session.js';

const visible = process.env.VISIBLE === '1';
const AIM = Number(process.env.AIM || 0.06);
const TICK = 2; // 몇 프레임마다 판단할지
const s = new Session();

// 페이지 안에 두는 판단 로직. 매 틱 상태를 보고 "마우스를 얼마나, 어느 버튼을, 어느 키를" 만 돌려준다.
const BRAIN = `
const { CFG } = await import('/src/config.js');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const A = window.ASCEND, c = A.climber, hs = A.level.holds;
const V = A.climber.pos.constructor;
const v1 = new V(), v2 = new V(), v3 = new V();
let resting = false;
const down = [false, false];
// 게임 루프가 매 프레임 events 를 비우므로 push 를 가로채 센다
const counts = {};
const push0 = c.events.push.bind(c.events);
c.events.push = (...e) => { for (const x of e) counts[x.type] = (counts[x.type] || 0) + 1; return push0(...e); };
window.__brain = {
  counts,
  decide(aim) {
    const grabbed = c.hands.filter(h => h.grabbed);
    const baseY = grabbed.length ? Math.max(...grabbed.map(h => h.anchor.y)) : c.pos.y;
    if (c.hands.some(h => h.grabbed && h.stamina < 0.4)) resting = true;
    if (c.hands.every(h => h.stamina > 0.8)) resting = false;

    let goal = null, best = -1e9, far = null, farD = 1e9;
    for (const h of hs) {
      if (h.users >= h.info.slots) continue;
      if (h.grabPoint.y < baseY + 0.10) continue;
      const d = h.grabPoint.distanceTo(c.pos);
      if (d <= CFG.reach * 0.92) { if (h.grabPoint.y > best) { best = h.grabPoint.y; goal = h; } }
      else if (d < farD && d < 2.6) { farD = d; far = h; }
    }
    if (!goal) goal = far;
    if (!goal) goal = { grabPoint: { x: c.pos.x, y: A.TOP_Y + 1.6, z: A.terrain.lipZ(c.pos.x) - 1.5 } };
    if (resting) {
      let bd = 1e9, near = null;
      for (const h of hs) {
        if (h.users >= h.info.slots) continue;
        const d = h.grabPoint.distanceTo(c.pos);
        if (d < bd) { bd = d; near = h; }
      }
      if (near) goal = near;
    }

    const u = c.up(v1), r = c.right(v2), f = c.forward(v3);
    const wx = goal.grabPoint.x - c.pos.x, wy = goal.grabPoint.y - c.pos.y, wz = goal.grabPoint.z - c.pos.z;
    const L = Math.hypot(wx, wy, wz) || 1;
    const fw = (wx * f.x + wy * f.y + wz * f.z) / L;
    const rw = (wx * r.x + wy * r.y + wz * r.z) / L;
    const uw = (wx * u.x + wy * u.y + wz * u.z) / L;
    const sens = CFG.lookSens * (c.grabCount > 0 ? CFG.lookSensGrabbed : 1);
    const k = resting ? 0 : aim;
    const dx = clamp(Math.atan2(rw, fw) / sens * k, -80, 80);
    const dy = clamp(-Math.atan2(uw, Math.hypot(fw, rw)) / sens * k, -80, 80);

    const keys = [];
    if (!resting) { if (fw > 0.45) keys.push('KeyW'); else if (fw < -0.35) keys.push('KeyS'); }

    const free = c.hands.findIndex(h => !h.grabbed);
    if (free >= 0) {
      const pick = c.pickHold(free);
      const worth = pick && (resting ? true : pick.grabPoint.y > baseY + 0.08);
      if (worth) down[free] = true;
    }
    if (!resting && c.hands[0].grabbed && c.hands[1].grabbed) {
      down[c.hands[0].anchor.y <= c.hands[1].anchor.y ? 0 : 1] = false;
    }
    for (let i = 0; i < 2; i++) if (down[i] && !c.hands[i].grabbed && c.hands[i].lockout > 0) down[i] = false;

    return { dx, dy, down: [...down], keys, resting,
      y: +c.pos.y.toFixed(2), top: A.TOP_Y, summited: c.summited,
      st: c.hands.map(h => +h.stamina.toFixed(2)), g: c.hands.map(h => h.grabbed) };
  },
};
return true;
`;

const BTN = ['left', 'right'];
const t0 = Date.now();
try {
  await s.open({ dir: path.resolve('../ascend'), visible, speed: Number(process.env.SPEED || 1) });
  if (visible) { await s.caption('ASCEND 완등 도전 - 사람과 같은 입력만 쓴다 (마우스 버튼 / 시선 / W,S)'); await new Promise((r) => setTimeout(r, 2500)); }
  await s.input([{ type: 'mouse', action: 'click' }]);       // 포인터 락
  const ok = await s.eval(BRAIN);
  if (!ok.ok) throw new Error(ok.error);

  const held = [false, false];
  const keysHeld = new Set();
  const stats = { slip: 0, miss: 0, fall: 0 };
  let frames = 0, maxY = 0, d;
  const LIMIT = 60 * 120;
  while (frames < LIMIT) {
    d = (await s.eval(`__brain.decide(${AIM})`)).value;
    maxY = Math.max(maxY, d.y);
    if (d.summited) break;

    // 버튼과 키는 바뀐 것만 진짜 이벤트로 보낸다 (누르고 있는 동안 잡는 게임이라 엣지가 중요하다)
    const acts = [];
    for (let i = 0; i < 2; i++) if (d.down[i] !== held[i]) { acts.push({ type: 'mouse', button: BTN[i], action: d.down[i] ? 'down' : 'up' }); held[i] = d.down[i]; }
    for (const k of ['KeyW', 'KeyS']) {
      const want = d.keys.includes(k);
      if (want !== keysHeld.has(k)) { acts.push({ type: 'key', key: k, action: want ? 'down' : 'up' }); want ? keysHeld.add(k) : keysHeld.delete(k); }
    }
    if (acts.length) await s.input(acts);

    if (visible) await s.caption(`높이 ${d.y.toFixed(1)} / ${d.top.toFixed(0)}m   ` +
      `왼손 ${d.g[0] ? '잡음' : '--'} ${Math.round(d.st[0] * 100)}%   오른손 ${d.g[1] ? '잡음' : '--'} ${Math.round(d.st[1] * 100)}%` +
      (d.resting ? '   [휴식: 양손으로 매달려 회복]' : '') + (d.keys.length ? `   ${d.keys[0] === 'KeyW' ? 'W 벽에 붙기' : 'S 벽에서 떼기'}` : ''));
    const r = await s.page.evaluate((o) => window.__gp.step(o), { frames: TICK, dt: 1000 / 60, lookDx: d.dx, lookDy: d.dy, speed: s.speed });
    frames += r.framesRun;
  }
  Object.assign(stats, (await s.eval('__brain.counts')).value);
  const res = { summited: d.summited, gameSec: +(frames / 60).toFixed(1), maxY: +maxY.toFixed(1), top: d.top, events: stats, wallSec: +((Date.now() - t0) / 1000).toFixed(1) };
  console.log(JSON.stringify(res));
  if (visible) {
    await s.caption(res.summited ? `정상 도착!  게임 시간 ${res.gameSec}초   미끄러짐 ${stats.slip}  놓침 ${stats.miss}  추락 ${stats.fall}` : `실패: 최고 ${res.maxY}m`);
    await new Promise((r) => setTimeout(r, 6000));
  }
} finally {
  await s.close();
}
