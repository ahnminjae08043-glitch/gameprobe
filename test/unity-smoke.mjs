// Unity 모드 스모크 테스트: 연결, 장면 목록, 값 읽기, 프레임 진행, 입력, 캡처, 결정성
import fs from 'node:fs';
import path from 'node:path';
import { UnitySession } from '../src/unity.js';
const exe = path.resolve('unity/TestGame/Build/TestGame.exe');
const s = new UnitySession();
const save = (n, b64) => { fs.writeFileSync(`out/${n}.jpg`, Buffer.from(b64, 'base64')); console.log('saved out/' + n + '.jpg'); };
try {
  const t0 = Date.now();
  console.log(JSON.stringify(await s.open({ exe })), Date.now() - t0, 'ms');
  console.log('tree', JSON.stringify((await s.eval('$tree(1)')).value).slice(0, 600));
  console.log('inspect', JSON.stringify((await s.eval("$inspect('Player')")).value).slice(0, 400));
  console.log('read', JSON.stringify(await s.eval('[await $("Player.transform.position"), await $("#GameManager.score"), await $("GameManager.Instance.totalCoins")]')));
  save('unity-1-start', await s.screenshot());
  // 앞으로 걸어 첫 코인(낮은 코인, z=4)을 먹는다
  const r = await s.step({ frames: 90, hold: { keys: ['KeyW'] }, watch: ['Player.transform.position.z', '#GameManager.score'], until: '$("#GameManager.score") > 0', screenshot: true });
  console.log('walk', JSON.stringify(r));
  save('unity-2-walk', s.lastJpeg);
  await s.input([{ type: 'key', key: 'Space' }]);
  const j = await s.step({ frames: 40, watch: ['Player.transform.position.y', 'Player.PlayerController.jumps'] });
  console.log('jump', JSON.stringify(j));
  const f = await s.filmstrip({ frames: 60, shots: 4, look: { dx: 8, dy: 0 } });
  fs.writeFileSync('out/unity-3-turn.jpg', Buffer.from(f.sheet, 'base64'));
  console.log('turn', JSON.stringify(f.summary));
  console.log('logs', JSON.stringify(await s.getLogs()).slice(0, 500));
} finally {
  await s.close();
}
