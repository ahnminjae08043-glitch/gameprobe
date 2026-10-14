// Puts music and sound effects on the demo video, timed from the timeline make-demo.mjs writes.
//   node tools/mix-audio.mjs              -> out/demo/gameprobe-demo.mp4 + gameprobe-demo-sound.webm
//   DEMO_LANG=ko node tools/mix-audio.mjs -> the -ko versions
// Audio (Pixabay Content License, no attribution required) goes in out/audio:
//   synthwave.mp3  "Synthwave Driving" by JonasBlakewood
//   sfx-boom.mp3 "Cinematic Impact Boom 05" (Universfield), sfx-whoosh.mp3 "Whoosh Cinematic" (DRAGON-STUDIO),
//   sfx-error.mp3 "Quick Error Signal" (Virtual_Vibes), sfx-success.mp3 "Success Notification" (Universfield),
//   sfx-reward.mp3 "Reward Chime" (Universfield)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const KO = process.env.DEMO_LANG === 'ko';
const DIR = path.resolve('out/demo'), AUDIO = path.resolve('out/audio');
const base = KO ? 'gameprobe-demo-ko' : 'gameprobe-demo';
const video = path.join(DIR, base + '.webm');
const marks = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(DIR, base + '.timeline.json'), 'utf8')).map((m) => [m.name, m.t]));

// ffmpeg: FFMPEG env, PATH, or where winget puts Gyan.FFmpeg
function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  if (spawnSync('ffmpeg', ['-version']).status === 0) return 'ffmpeg';
  const pk = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  for (const d of fs.existsSync(pk) ? fs.readdirSync(pk) : []) {
    if (!d.startsWith('Gyan.FFmpeg')) continue;
    for (const b of fs.readdirSync(path.join(pk, d))) {
      const exe = path.join(pk, d, b, 'bin', 'ffmpeg.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  throw new Error('ffmpeg not found: install it (winget install Gyan.FFmpeg) or set FFMPEG');
}
const FF = findFfmpeg();

// The music's drop lands on the "an AI agent found this bug" card: tension under the hook, release on the reveal.
const MUSIC_DROP = 7.8;
const musicDelay = Math.max(0, marks.aiCard - MUSIC_DROP);
const musicSkip = Math.max(0, MUSIC_DROP - marks.aiCard);
const end = marks.done;

const sfx = [
  ['boom', marks.fall, 1.0],
  ['whoosh', marks.replay - 0.15, 0.55],
  ['whoosh', marks.brand - 0.15, 0.55],
  ['whoosh', marks.ghosts - 0.15, 0.5],
  ['error', marks.ghostDied, 0.5],
  ['success', marks.best, 0.8],
  ['whoosh', marks.unity - 0.15, 0.5],
  ['error', marks.plus2, 0.9],
  ['success', marks.compare + 0.3, 0.8],
  ['whoosh', marks.ascend - 0.15, 0.5],
  ['reward', marks.summit, 0.9],
  ['whoosh', marks.end - 0.15, 0.55],
].filter(([, t]) => Number.isFinite(t) && t >= 0);

const inputs = ['-i', video, '-i', path.join(AUDIO, 'synthwave.mp3')];
for (const [name] of sfx) inputs.push('-i', path.join(AUDIO, `sfx-${name}.mp3`));
const parts = [];
parts.push(`[1:a]atrim=start=${musicSkip.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${Math.round(musicDelay * 1000)}:all=1,` +
  `afade=t=in:d=0.3,afade=t=out:st=${(end - 1.3).toFixed(3)}:d=1.3,volume=0.75[music]`);
sfx.forEach(([, t, gain], k) => parts.push(`[${k + 2}:a]adelay=${Math.round(t * 1000)}:all=1,volume=${gain}[s${k}]`));
parts.push(`[music]${sfx.map((_, k) => `[s${k}]`).join('')}amix=inputs=${sfx.length + 1}:normalize=0:duration=first,` +
  `atrim=end=${end.toFixed(3)},loudnorm=I=-15.3:TP=-1.5:LRA=11,aresample=48000[a]`);

function run(args) {
  const r = spawnSync(FF, ['-hide_banner', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr.slice(-2000));
}
const graph = parts.join(';');
const mp4 = path.join(DIR, base + '.mp4'), webm = path.join(DIR, base + '-sound.webm');
run([...inputs, '-filter_complex', graph, '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', mp4]);
run([...inputs, '-filter_complex', graph, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'libopus', '-b:a', '160k', '-shortest', webm]);

// check: loudness and true peak of the result
const m = spawnSync(FF, ['-hide_banner', '-i', mp4, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
const I = m.match(/I:\s+(-?[\d.]+) LUFS/g)?.pop(), P = m.match(/Peak:\s+(-?[\d.]+) dBFS/g)?.pop();
console.log(`music delay ${musicDelay.toFixed(2)} s, skip ${musicSkip.toFixed(2)} s, ${sfx.length} effects`);
console.log(`${path.basename(mp4)} ${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB, ${path.basename(webm)} ${(fs.statSync(webm).size / 1e6).toFixed(1)} MB, ${I}, true ${P}`);
