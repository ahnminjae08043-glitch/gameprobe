import { Session } from '../src/session.js';
const P = [[120, 420], [300, 340], [480, 260], [660, 180], [820, 80]];
const s = new Session();
for (const D of [50, 60, 70]) {
  await s.open({ dir: 'examples/buggy-platformer' }); const dt = 1000 / +(process.argv[2] || 60);
  const got = [];
  for (const [px, py] of P) {
    await s.step({ frames: 300, dt, hold: { keys: ['ArrowRight'] }, until: `game.player.x >= ${px - D}` });
    await s.step({ frames: 1, dt, hold: { keys: ['ArrowRight', 'Space'] } });
    await s.step({ frames: 120, dt, hold: { keys: ['ArrowRight'] }, until: `game.player.x >= ${px + 30} || game.player.onGround` });
    await s.step({ frames: 120, dt, until: 'game.player.onGround' });
    const y = (await s.eval('game.player.y')).value;
    got.push(y === py - 24 ? 'ok' : y);
    if (y !== py - 24) break;
  }
  console.log(D, got.join(' '));
}
await s.close();
