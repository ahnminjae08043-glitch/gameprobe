// 에디터 플레이 모드: 멈춤 유지, 프레임 수 정확도, 입력, 읽기
import fs from 'node:fs';
import { UnitySession } from '../src/unity.js';
const s = new UnitySession();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  console.log(JSON.stringify(await s.open({ unity: 47777, warmupFrames: 0 })).slice(0, 200));
  const f0 = (await s.eval('$("$frame")')).value; await sleep(1500); const f1 = (await s.eval('$("$frame")')).value;
  console.log('paused while waiting:', f0 === f1, f0, f1);
  for (const n of [1, 5, 60]) {
    const a = (await s.eval('$("$frame")')).value;
    const r = await s.step({ frames: n });
    await sleep(300);
    const b = (await s.eval('$("$frame")')).value;
    console.log(`step ${n}: framesRun ${r.framesRun}, frame delta ${b - a}`);
  }
  const w = await s.step({ frames: 60, hold: { keys: ['KeyW'] }, watch: ['Player.transform.position.z', '#GameManager.score'], screenshot: true });
  console.log('walk', JSON.stringify(w.watch));
  fs.writeFileSync('out/unity-editor.jpg', Buffer.from(s.lastJpeg, 'base64'));
} finally {
  await s.close();
}
