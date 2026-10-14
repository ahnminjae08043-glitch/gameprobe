// 영상 확인용: 여러 시점의 프레임을 한 장의 격자로 뽑는다
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
const file = path.resolve(process.argv[2]);
const times = (process.argv[3] || '1,4,7,10,13,16,19,22,25,28,31,34,37,40,44,48,52,55').split(',').map(Number);
// 탐색(seek)하려면 브라우저가 Range 요청을 쓰므로 부분 응답을 지원한다
const size = fs.statSync(file).size;
const server = http.createServer((q, r) => {
  if (!q.url.startsWith('/v.webm')) { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end('<video id=v src="/v.webm" muted preload=auto></video><canvas id=c></canvas>'); return; }
  const m = /bytes=(\d+)-(\d*)/.exec(q.headers.range || '');
  if (!m) { r.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': size, 'Accept-Ranges': 'bytes' }); fs.createReadStream(file).pipe(r); return; }
  const a = +m[1], e = m[2] ? +m[2] : size - 1;
  r.writeHead(206, { 'Content-Type': 'video/webm', 'Content-Range': `bytes ${a}-${e}/${size}`, 'Content-Length': e - a + 1, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file, { start: a, end: e }).pipe(r);
}).listen(0);
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage();
await p.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
const b64 = await p.evaluate(async (times) => {
  const v = document.getElementById('v'); await new Promise((r) => (v.readyState >= 1 ? r() : v.addEventListener('loadedmetadata', r, { once: true })));
  const cols = 6, tw = 320, th = 180, c = document.getElementById('c'); c.width = cols * tw; c.height = Math.ceil(times.length / cols) * th; const g = c.getContext('2d');
  for (let i = 0; i < times.length; i++) {
    v.currentTime = times[i]; await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    const x = (i % cols) * tw, y = Math.floor(i / cols) * th; g.drawImage(v, x, y, tw, th);
    g.fillStyle = '#000a'; g.fillRect(x, y, 44, 18); g.fillStyle = '#fff'; g.font = '13px monospace'; g.fillText(times[i] + 's', x + 4, y + 13);
  }
  return [c.toDataURL('image/jpeg', 0.85).split(',')[1], v.duration];
}, times);
fs.writeFileSync('out/demo/sheet.jpg', Buffer.from(b64[0], 'base64'));
console.log('duration', b64[1]);
await b.close(); server.close();
