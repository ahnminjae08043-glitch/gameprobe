// 범용 폴백 스모크 테스트: 네이티브 게임을 띄워 찾고, 얼리고, 찍고, 필름스트립을 만든다
import fs from 'node:fs';
import { NativeSession } from '../src/native.js';
const exe = process.argv[2];
const s = new NativeSession();
const save = (name, b64) => { fs.writeFileSync(`out/${name}.jpg`, Buffer.from(b64, 'base64')); console.log('saved out/' + name + '.jpg'); };
try {
  const t0 = Date.now();
  console.log(JSON.stringify(await s.open({ exe, startupMs: 12000 })), Date.now() - t0, 'ms');
  save('native-1-open', await s.screenshot({ scale: 0.5 }));
  // 얼어 있는 동안 화면이 정말 멈춰 있는지: 1초 간격 두 장이 같아야 한다
  const a = await s.probe(); await new Promise((r) => setTimeout(r, 1000)); const b = await s.probe();
  console.log('frozen diff', JSON.stringify(NativeSession.diff(a, b)));
  const st = await s.step({ ms: 3000, untilScreen: { change: 0.08 } });
  console.log('step', JSON.stringify(st));
  const f = await s.filmstrip({ ms: 4000, shots: 8, cols: 4 });
  save('native-2-film', f.sheet);
  console.log(JSON.stringify(f.summary), s.getLogs().slice(-5));
} finally {
  await s.close();
}
