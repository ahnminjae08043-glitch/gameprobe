// Estencel 키보드 진입: 메뉴 Enter → 슬롯 화면에서 아래 화살표로 2번 슬롯 → 확인 후 Enter
// stage=menu: 슬롯 화면까지 가서 아래 화살표 한 번 누른 화면을 찍고 멈춘다 (2번 하이라이트 확인용)
// stage=go:   같은 경로로 가서 2번 슬롯 Enter → 게임 진입 → 이동/시선 필름스트립
import fs from 'node:fs';
import { NativeSession } from '../src/native.js';
const [exe, stage = 'menu'] = process.argv.slice(2);
const s = new NativeSession();
const save = (name, b64) => { fs.writeFileSync(`out/${name}.jpg`, Buffer.from(b64, 'base64')); console.log('saved out/' + name + '.jpg'); };
try {
  await s.open({ exe, startupMs: 12000 });
  console.log('enter@menu', JSON.stringify(await s.input([{ type: 'key', key: 'Enter' }])));
  await s.step({ ms: 2500 });
  save('enter-1-slots', await s.screenshot({ scale: 0.5 }));
  console.log('down', JSON.stringify(await s.input([{ type: 'key', key: 'ArrowDown' }])));
  await s.step({ ms: 800 });
  save('enter-2-slot2', await s.screenshot({ scale: 0.5 }));
  if (stage === 'go') {
    // 안전장치: 2번 슬롯 줄이 1번 줄보다 밝아야(하이라이트) Enter 를 누른다. 아니면 사용자 세이브를 건드릴 수 있으니 중단
    const { w, h } = s.win.rect;
    const row = (cy) => [Math.round(w * 0.11), Math.round(h * (cy - 0.035)), Math.round(w * 0.41), Math.round(h * 0.07)];
    const lum = (p) => p.r + p.g + p.b;
    const s1 = await s.probe(row(0.287)), s2 = await s.probe(row(0.389));
    console.log('slot1 lum', lum(s1), 'slot2 lum', lum(s2));
    if (!(lum(s2) >= lum(s1) * 1.4 && lum(s2) - lum(s1) >= 5)) throw new Error('slot 2 is not highlighted; aborting so the existing save is never loaded');
    await s.input([{ type: 'key', key: 'Enter' }]);
    console.log('load', JSON.stringify(await s.step({ ms: 25000, untilScreen: { change: 0.12 } })));
    await s.step({ ms: 8000 });
    save('enter-3-ingame', await s.screenshot({ scale: 0.5 }));
    save('enter-4-walk', (await s.filmstrip({ ms: 3000, shots: 4, cols: 4, hold: { keys: ['KeyW'] } })).sheet);
    save('enter-5-look', (await s.filmstrip({ ms: 2000, shots: 4, cols: 4, look: { dx: 12, dy: 0 } })).sheet);
  }
} finally {
  await s.close();
}
