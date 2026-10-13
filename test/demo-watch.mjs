// 관전용 데모: 창을 띄우고 실제 속도로 에이전트가 플레이하는 모습을 보여준다.
//   node test/demo-watch.mjs            플랫포머 → ASCEND 순서로
//   node test/demo-watch.mjs platformer
//   node test/demo-watch.mjs ascend
import path from 'node:path';
import { Session } from '../src/session.js';

const which = process.argv[2] || 'all';
const speed = Number(process.env.SPEED || 1);
const s = new Session();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const say = async (t, ms = 2200) => { console.log('  ' + t.replace(/\n/g, ' / ')); await s.caption(t); await pause(ms); };

async function platformer(fps, label) {
  await s.open({ dir: 'examples/buggy-platformer', visible: true, speed });
  const dt = 1000 / fps;
  await say(`${label}: ${fps} fps 로 플레이한다`, 2500);
  const P = [[120, 420], [300, 340], [480, 260], [660, 180], [820, 80]];
  for (const [px, py] of P) {
    await s.step({ frames: 300, dt, hold: { keys: ['ArrowRight'] }, until: `game.player.x >= ${px - 60}` });
    await s.step({ frames: 1, dt, hold: { keys: ['ArrowRight', 'Space'] } });
    await s.step({ frames: 120, dt, hold: { keys: ['ArrowRight'] }, until: `game.player.x >= ${px + 30} || game.player.onGround` });
    await s.step({ frames: 120, dt, until: 'game.player.onGround' });
  }
  const coin = (await s.eval('game.coin.taken')).value;
  await say(`타워 도착, 코인 ${coin ? '획득' : '못 먹음'}. 이제 오른쪽 끝에서 다리로 뛰어내린다`, 2500);
  await s.step({ frames: 120, dt, hold: { keys: ['ArrowRight'] }, until: '!game.player.onGround' });
  const r = await s.step({ frames: 300, dt, until: 'game.player.deaths > 0 || game.player.onGround', watch: ['Math.round(game.player.vy)'] });
  const died = (await s.eval('game.player.deaths')).value > 0;
  const vmax = r.watch['Math.round(game.player.vy)'].max;
  const perFrame = Math.round(vmax * dt / 1000);
  await say(died
    ? `결과: 다리를 뚫고 추락사 (BUG)\n낙하 속도 ${vmax}px/s = 프레임당 ${perFrame}px > 판정 범위 28px`
    : `결과: 다리에 정상 착지\n낙하 속도 ${vmax}px/s = 프레임당 ${perFrame}px < 판정 범위 28px`, 4500);
  return died;
}

async function ascend() {
  await s.open({ dir: path.resolve('../ascend'), visible: true, speed });
  await say('ASCEND: 화면 클릭으로 시작 (포인터 락은 gameprobe가 흉내낸다)', 2500);
  await s.input([{ type: 'mouse', action: 'click' }]);
  const W = ['Math.round(ASCEND.climber.pos.y * 100) / 100'];
  for (let i = 0; i < 4; i++) {
    const hand = i % 2 ? 'right' : 'left';
    const r = await s.step({ frames: 75, hold: { buttons: [hand], keys: ['KeyW'] }, look: { dx: i % 2 ? -2 : 2, dy: -6 }, watch: W });
    await s.caption(`${hand === 'left' ? '왼손' : '오른손'}으로 잡고 시선을 위로 훑어 몸을 끌어올림   높이 ${r.watch[W[0]].last ?? r.watch[W[0]].constant}m`);
    await pause(900);
  }
  await say('양손을 놓는다 -> 추락. until 로 바닥에 닿는 프레임에서 정확히 멈춘다', 2000);
  const r = await s.step({ frames: 400, until: 'ASCEND.climber.pos.y < 0.9', watch: W });
  await say(`추락 ${r.framesRun} 프레임 만에 착지 감지 (untilMet=${r.untilMet})`, 3500);
}

try {
  if (which === 'all' || which === 'platformer') {
    const fast = await platformer(60, '1회차 - 빠른 PC');
    const slow = await platformer(30, '2회차 - 느린 노트북');
    console.log(`60fps ${fast ? '추락' : '착지'} / 30fps ${slow ? '추락' : '착지'}`);
  }
  if (which === 'all' || which === 'ascend') await ascend();
} finally {
  await s.close();
}
