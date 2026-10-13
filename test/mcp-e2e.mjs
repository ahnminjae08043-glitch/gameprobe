// MCP 프로토콜 경유 end-to-end 테스트: 서버를 자식 프로세스로 띄우고 도구를 차례로 호출한다.
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dir = path.resolve(process.argv[2] || '../ascend');
const client = new Client({ name: 'e2e', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['src/server.js'] }));
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log('tools', tools.join(' '));

let n = 0;
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  for (const c of r.content) {
    if (c.type === 'text') console.log(`[${name}]${r.isError ? ' ERROR' : ''}`, c.text.length > 900 ? c.text.slice(0, 900) + '…' : c.text);
    else { const f = `out/e2e-${++n}-${name}.jpg`; fs.writeFileSync(f, Buffer.from(c.data, 'base64')); console.log(`[${name}] image -> ${f}`); }
  }
  return r;
}

await call('game_open', { dir });
await call('game_input', { actions: [{ type: 'mouse', action: 'click' }] });
await call('game_eval', { code: 'ASCEND.input.locked' });
// 왼손으로 잡고 시선을 위로 훑어 몸을 끌어올린다
await call('game_step', { frames: 90, hold: { buttons: ['left'] }, look: { dx: 0, dy: -5 }, watch: ['ASCEND.climber.pos.y', 'ASCEND.climber.grabCount'], every: 10 });
// 손을 놓으면 떨어져야 한다: until 로 착지 순간을 잡는다
await call('game_step', { frames: 300, watch: ['ASCEND.climber.grabCount'], until: 'ASCEND.climber.pos.y < 0.9', screenshot: true });
await call('game_filmstrip', { frames: 120, shots: 6, cols: 3, hold: { buttons: ['right'] }, look: { dx: 2, dy: -6 }, watch: ['ASCEND.climber.pos.y'] });
await call('game_eval', { code: 'const c = ASCEND.climber; return { pos: c.pos, hands: c.hands.map(h => ({ grabbed: h.grabbed, stamina: h.stamina })) }' });
await call('game_eval', { code: 'undefinedThing.foo' });
await call('game_logs', { types: ['error', 'pageerror'] });
await call('game_realtime', { running: true });
await new Promise((r) => setTimeout(r, 500));
await call('game_realtime', { running: false });
await call('game_close');
await client.close();
