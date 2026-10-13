// game_run 스윕: 프레임레이트별로 타워에서 떨어뜨려 관통 여부를 한 번의 호출로 본다
import { Session } from '../src/session.js';
const s = new Session();
await s.open({ dir: 'examples/buggy-platformer' });
const t0 = Date.now();
const r = await s.run({
  sweep: { name: 'fps', values: [144, 60, 45, 30, 20] },
  steps: [
    { eval: 'Object.assign(game.player, { x: 900, y: 56 }); true' },
    { step: { frames: 3, dt: '1000/$fps' } },
    { step: { frames: 120, dt: '1000/$fps', hold: { keys: ['ArrowRight'] }, until: '!game.player.onGround' } },
    { step: { frames: 300, dt: '1000/$fps', until: 'game.player.deaths > 0 || game.player.onGround' } },
  ],
  result: '({ died: game.player.deaths > 0, y: Math.round(game.player.y) })',
});
console.log(JSON.stringify(r, null, 1), Date.now() - t0, 'ms');
await s.close();
