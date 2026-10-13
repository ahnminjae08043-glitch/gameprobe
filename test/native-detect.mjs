// 어두운 메뉴 전환을 화면 변화 감지로 잡는지: 메인 메뉴 Enter → 슬롯 화면, 슬롯 화면 ↓ → 하이라이트 이동
import { NativeSession } from '../src/native.js';
const s = new NativeSession();
try {
  await s.open({ exe: process.argv[2], startupMs: 12000 });
  const frozen = [await s.probe(), await new Promise((r) => setTimeout(r, 800)).then(() => s.probe())];
  console.log('frozen 0.8s', JSON.stringify(NativeSession.diff(...frozen)));
  await s.input([{ type: 'key', key: 'Enter' }]);
  console.log('menu->slots', JSON.stringify(await s.step({ ms: 8000, untilScreen: { anyChange: 0.25 } })));
  await s.step({ ms: 1500 });
  await s.input([{ type: 'key', key: 'ArrowDown' }]);
  console.log('highlight', JSON.stringify(await s.step({ ms: 3000, untilScreen: { anyChange: 0.25 } })));
  console.log('idle', JSON.stringify(await s.step({ ms: 2000, untilScreen: { anyChange: 0.25 } })));
} finally {
  await s.close();
}
