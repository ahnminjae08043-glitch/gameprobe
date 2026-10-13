// game_control 기본 동작: 키 유지·해제 이벤트, mem, log, until, 에러 처리, 필름스트립
import fs from 'node:fs';
import { Session } from '../src/session.js';
const s = new Session();
await s.open({ dir: 'examples/buggy-platformer' });
let r = await s.control({
  frames: 120, watch: ['Math.round(game.player.x)'], every: 30,
  policy: `ctx.mem.n = (ctx.mem.n || 0) + 1; if (ctx.frame % 40 === 0) ctx.log('x=' + Math.round(game.player.x)); return { keys: ['ArrowRight'] };`,
});
console.log('walk', JSON.stringify(r.summary));
r = await s.control({ frames: 60, policy: `return {};`, watch: ['Math.round(game.player.x)'] });
console.log('released', JSON.stringify(r.summary.watch));
r = await s.control({ frames: 600, until: 'game.player.y < 400', policy: `return { keys: game.player.onGround ? ['Space'] : [] };`, watch: ['Math.round(game.player.y)'] });
console.log('jump', JSON.stringify(r.summary));
r = await s.control({ frames: 60, policy: `if (ctx.i > 5) undefinedThing.x; return {};` });
console.log('error', JSON.stringify(r.summary));
r = await s.control({ frames: 60, policy: `return {` });
console.log('syntax', JSON.stringify(r));
r = await s.control({ frames: 120, shots: 4, policy: `return { keys: ['ArrowLeft'] };` });
fs.writeFileSync('out/control-film.jpg', Buffer.from(r.sheet, 'base64'));
console.log('film', JSON.stringify(r.summary));
await s.close();
