// 범용 폴백 플레이 테스트: 메뉴 클릭 → 게임 진입 → WASD + 시선으로 움직여 보기
import fs from 'node:fs';
import { NativeSession } from '../src/native.js';
const s = new NativeSession();
const save = (name, b64) => { fs.writeFileSync(`out/${name}.jpg`, Buffer.from(b64, 'base64')); console.log('saved out/' + name + '.jpg'); };
try {
  const o = await s.open({ exe: process.argv[2], startupMs: 12000 });
  const { width: W, height: H } = o.window;
  // 메뉴의 "시작" 버튼: 스크린샷 기준 화면 가로 50%, 세로 57.8%
  console.log('click', JSON.stringify(await s.input([{ type: 'mouse', action: 'click', x: Math.round(W * 0.5), y: Math.round(H * 0.578) }])));
  const st = await s.step({ ms: 15000, untilScreen: { change: 0.15 } });
  console.log('after click', JSON.stringify(st));
  await s.step({ ms: 1500 });
  save('play-1-slots', await s.screenshot({ scale: 0.5 }));
  // 비어 있는 2번 슬롯의 "새로운 게임" (1번은 기존 세이브라 건드리지 않는다, 클리어 버튼도 피한다)
  console.log('slot2', JSON.stringify(await s.input([{ type: 'mouse', action: 'click', x: Math.round(W * 0.323), y: Math.round(H * 0.389) }])));
  const ld = await s.step({ ms: 25000, untilScreen: { change: 0.12 } });
  console.log('after slot2', JSON.stringify(ld));
  await s.step({ ms: 8000 });
  save('play-1-entered', await s.screenshot({ scale: 0.5 }));
  const f1 = await s.filmstrip({ ms: 3000, shots: 4, cols: 4, hold: { keys: ['KeyW'] } });
  save('play-2-walk', f1.sheet);
  const f2 = await s.filmstrip({ ms: 2000, shots: 4, cols: 4, look: { dx: 12, dy: 0 } });
  save('play-3-look', f2.sheet);
} finally {
  await s.close();
}
