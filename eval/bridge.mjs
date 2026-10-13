// 평가용: MCP 서버 앞에 HTTP 다리를 놓아, MCP를 직접 못 붙이는 에이전트도 같은 도구를 프로토콜 경유로 쓰게 한다.
// POST /call {"name":"game_step","arguments":{...}} -> 텍스트는 그대로, 이미지는 파일로 저장하고 경로를 돌려준다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const imgDir = path.resolve(process.argv[2] || 'out/bridge');
fs.mkdirSync(imgDir, { recursive: true });
const client = new Client({ name: 'bridge', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['src/server.js'] }));
const log = fs.createWriteStream('eval/bridge-calls.jsonl');
let n = 0;
http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  try {
    if (req.url === '/tools') { res.end(JSON.stringify((await client.listTools()).tools, null, 1)); return; }
    const { name, arguments: args = {} } = JSON.parse(body);
    log.write(JSON.stringify({ name, args }) + '\n');
    const r = await client.callTool({ name, arguments: args });
    const out = r.content.map((c) => {
      if (c.type === 'text') return c.text;
      const f = path.join(imgDir, `${String(++n).padStart(3, '0')}-${name}.jpg`);
      fs.writeFileSync(f, Buffer.from(c.data, 'base64'));
      return `[image saved: ${f}]`;
    });
    res.end((r.isError ? 'ERROR ' : '') + out.join('\n'));
  } catch (e) { res.statusCode = 500; res.end(String(e)); }
}).listen(7788, '127.0.0.1', () => console.log('bridge on http://127.0.0.1:7788'));
