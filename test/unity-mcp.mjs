// MCP 경유 유니티 모드: 자동 감지, 트리, 컨트롤 2회 결정성, 버그(코인 이중 집계) 확인
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const exe = path.resolve('unity/TestGame/Build/TestGame.exe');
const client = new Client({ name: 'unity-e2e', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['src/server.js'] }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const img = r.content.find((c) => c.type === 'image');
  if (img) fs.writeFileSync(`out/umcp-${name}.jpg`, Buffer.from(img.data, 'base64'));
  console.log(`[${name}]${r.isError ? ' ERROR' : ''}`, t.slice(0, 500));
  return t;
};
await call('game_open', { exe });
await call('game_eval', { code: '$tree(1)' });
const policy = `
const z = $("Player.transform.position.z"), score = $("#GameManager.score");
if (!ctx.mem.last) ctx.mem.last = 0;
if (score !== ctx.mem.last) { ctx.log("score " + ctx.mem.last + " -> " + score + " at z=" + z.toFixed(2)); ctx.mem.last = score; }
return { keys: ["KeyW"] };`;
const a = await call('game_control', { policy, frames: 120, until: '$("#GameManager.score") >= 1', watch: ['#GameManager.score'] });
const b = await call('game_control', { policy, frames: 120, reset: true, until: '$("#GameManager.score") >= 1', watch: ['#GameManager.score'] });
console.log(a === b ? 'DETERMINISTIC' : 'DIFFERENT');
await call('game_step', { frames: 1, screenshot: true });
await call('game_logs');
await call('game_close');
await client.close();
