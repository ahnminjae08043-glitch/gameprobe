// reset: 같은 정책을 두 번 돌리면 결과가 같아야 한다 (에이전트 최종 컨트롤러 축약판)
import { Session } from '../src/session.js';
const s = new Session();
await s.open({ dir: 'examples/buggy-platformer' });
const policy = `const p=game.player,c=game.coin,L=game.level,m=ctx.mem;
if(c.taken&&!m.got){m.got=1;ctx.log('coin x='+p.x.toFixed(1));}
if(!m.got){let j=false;if(p.onGround){const f=p.y+p.h;const pl=L.slice(0,6).find(q=>Math.abs(q.y-f)<1&&p.x+p.w>q.x&&p.x<q.x+q.w);
if(!pl||pl===L[0])j=true;else if(pl===L[4])j=p.x>=730;else if(pl===L[5])j=p.x>=862;else if(p.x+p.w>=pl.x+pl.w-2)j=true;}
return {keys:j?['ArrowRight','Space']:['ArrowRight']};}
if(p.x<=40&&p.onGround)return {};return {keys:['ArrowLeft']};`;
const outs = [];
for (let k = 0; k < 2; k++) {
  const r = await s.control({ policy, reset: true, frames: 900, samples: 50, watch: ['Math.round(game.player.x)'],
    until: 'game.player.deaths>0 || (game.coin.taken && game.player.x<=40 && game.player.onGround)' });
  const w = r.summary.watch['Math.round(game.player.x)'];
  const line = JSON.stringify({ untilMet: r.summary.untilMet, controlTimeMs: r.summary.controlTimeMs, log: r.summary.policyLog, samples: w.samples.length });
  console.log(line); outs.push(line);
}
await s.close();
if (outs[0] !== outs[1] || !outs[0].includes('"untilMet":true')) { console.error('FAIL: runs differ or did not finish'); process.exit(1); }
console.log('PASS deterministic controller');
