// 가설 확인: 실행 중 화면 복사는 검게, 얼린 뒤 화면 복사는 정상인가
import { NativeSession } from '../src/native.js';
const s = new NativeSession();
const hex = (p) => '#' + [p.r, p.g, p.b].map((v) => v.toString(16).padStart(2, '0')).join('');
try {
  await s.open({ exe: process.argv[2], startupMs: 12000 });
  await s.focus();
  console.log('frozen  screen', hex(await s.probe()));
  await s.freeze(false); await new Promise((r) => setTimeout(r, 500));
  for (const m of ['screen', 'print']) {
    s.method = m;
    const p = await s.probe();
    console.log('running', m.padEnd(6), hex(p));
  }
  await s.freeze(true);
  s.method = 'screen';
  console.log('frozen  screen', hex(await s.probe()));
} finally {
  await s.close();
}
