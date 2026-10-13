// 같은 입력을 두 번 넣으면 상태가 비트 단위로 같아야 한다
import path from 'node:path';
import { Session } from '../src/session.js';
const dir = path.resolve(process.argv[2] || '../ascend');
async function run() {
  const s = new Session();
  await s.open({ dir });
  await s.input([{ type: 'mouse', action: 'click' }]);
  await s.step({ frames: 90, hold: { buttons: ['left'] }, look: { dx: 1, dy: -5 } });
  await s.step({ frames: 120, hold: { buttons: ['right'], keys: ['KeyW'] }, look: { dx: -2, dy: -6 } });
  const r = await s.page.evaluate(() => { const c = ASCEND.climber; return JSON.stringify([c.pos.toArray(), c.vel?.toArray?.(), c.hands.map(h => [h.grabbed, h.stamina])]); });
  await s.close();
  return r;
}
const a = await run(), b = await run();
console.log(a); console.log(b);
console.log(a === b ? 'DETERMINISTIC' : 'DIFFERENT');
process.exit(a === b ? 0 : 1);
