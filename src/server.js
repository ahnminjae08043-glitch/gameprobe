#!/usr/bin/env node
// gameprobe MCP 서버 (stdio). stdout은 MCP 프로토콜 전용이므로 로그는 stderr로만 쓴다.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Session } from './session.js';

const INSTRUCTIONS = `gameprobe lets you play and verify a web game (canvas/WebGL/three.js/Phaser/etc.) without changing its code.

Time is virtual. After game_open the game is PAUSED and only advances when you call game_step or game_filmstrip,
so every run is reproducible and nothing happens between your calls. requestAnimationFrame, performance.now and
Date.now are controlled; setTimeout/setInterval still run on real time.

Typical loop:
1. game_open {dir: "<game folder>"} (or {url}) -> look at the returned screenshot-free summary, then game_screenshot.
2. Use game_input for one-off actions (click to start, press a key). Pointer lock is emulated, so clicking a canvas that
   asks for pointer lock just works.
3. game_step to advance N frames while holding keys/buttons and moving the view (look.dx/dy = mouse movement per frame).
   Pass watch expressions (any JS expression over the game's globals) to get a compact time series back, and "until"
   to stop as soon as a condition is true. Prefer watch over screenshots for numbers: it is cheaper and exact.
4. game_filmstrip when you need to SEE motion: one image with several frames in a grid.
5. game_eval to read or poke state; game_logs for console errors, failed requests and exceptions thrown inside frames.

To find bugs, state the expectation as an until/watch expression (e.g. until: "player.y < -50" to catch falling
through the floor) rather than eyeballing screenshots.`;

const session = new Session();
const server = new McpServer({ name: 'gameprobe', version: '0.1.0' }, { instructions: INSTRUCTIONS });

const text = (obj) => ({ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) });
const image = (b64) => ({ type: 'image', data: b64, mimeType: 'image/jpeg' });
const wrap = (fn) => async (args) => {
  try { return { content: await fn(args) }; }
  catch (e) { return { content: [text(`error: ${e.message}`)], isError: true }; }
};

const Hold = z.object({
  keys: z.array(z.string()).optional().describe('Keys held down during the frames, Playwright names: "KeyW", "ArrowUp", "Space", "ShiftLeft"'),
  buttons: z.array(z.enum(['left', 'right', 'middle'])).optional().describe('Mouse buttons held down during the frames'),
}).optional();
const Look = z.object({ dx: z.number(), dy: z.number() }).optional()
  .describe('Mouse movement in pixels applied EVERY frame (movementX/Y). Negative dy looks up.');

server.registerTool('game_open', {
  title: 'Open a game',
  description: 'Launch a headless browser (installed Chrome/Edge, real GPU) and open the game. Give a local folder (served for you, no cache) or a URL. Closes any previously open game. Starts paused.',
  inputSchema: {
    dir: z.string().optional().describe('Folder containing index.html'),
    path: z.string().optional().describe('Path inside dir, default "/"'),
    url: z.string().optional().describe('Use instead of dir for an already running server'),
    width: z.number().int().optional(), height: z.number().int().optional(),
    paused: z.boolean().optional().describe('Default true. false = run in real time like a normal browser'),
    headless: z.boolean().optional().describe('Default true. false shows a visible window'),
    visible: z.boolean().optional().describe('Spectator mode for a human watching: visible window, frames paced in real time, captions of what you are doing. Results are identical. Default from env GAMEPROBE_VISIBLE=1'),
    speed: z.number().min(0.05).max(20).optional().describe('Playback speed in spectator mode (default 1 = real time)'),
    screenshot: z.boolean().optional().describe('Also return a screenshot (default true)'),
    seed: z.number().int().nullable().optional().describe('Math.random seed for reproducible runs (default 1). null keeps the real Math.random'),
  },
}, wrap(async (a) => {
  const info = await session.open(a);
  const out = [text(info)];
  if (a.screenshot !== false) out.push(image(await session.screenshot()));
  return out;
}));

server.registerTool('game_input', {
  title: 'Send input',
  description: 'Send one-off input events in order. Does not advance game time (call game_step after, the game reads input on its next frame). Types: key {key, action: press|down|up}, text {text}, mouse {button, action: click|down|up, x?, y?}, move {x, y} absolute cursor, look {dx, dy} one relative mouse movement, wheel {dx, dy}, wait {ms} real time.',
  inputSchema: {
    actions: z.array(z.object({
      type: z.enum(['key', 'text', 'mouse', 'move', 'look', 'wheel', 'wait']),
      key: z.string().optional(), action: z.enum(['press', 'down', 'up', 'click']).optional(),
      text: z.string().optional(), button: z.enum(['left', 'right', 'middle']).optional(),
      x: z.number().optional(), y: z.number().optional(), dx: z.number().optional(), dy: z.number().optional(),
      ms: z.number().optional(), steps: z.number().optional(),
    })),
  },
}, wrap(async ({ actions }) => [text(await session.input(actions))]));

server.registerTool('game_step', {
  title: 'Advance frames',
  description: 'Advance the game N frames of virtual time (default 60 frames = 1s at 16.67ms). Optionally hold keys/buttons and move the view every frame, sample watch expressions, and stop early when "until" becomes true. Returns compact time series (first/last/min/max + samples for numbers, value changes otherwise), exceptions thrown inside frames, and optionally a screenshot of the final frame.',
  inputSchema: {
    frames: z.number().int().min(1).max(36000).optional(),
    dt: z.number().optional().describe('Milliseconds per frame, default 16.667'),
    hold: Hold, look: Look,
    watch: z.array(z.string()).optional().describe('JS expressions evaluated in the page each frame, e.g. "player.x", "game.state", "scene.children.length"'),
    every: z.number().int().optional().describe('Sample watch every N frames (default 1)'),
    until: z.string().optional().describe('Stop as soon as this JS expression is truthy, e.g. "player.y < -50"'),
    screenshot: z.boolean().optional().describe('Return a screenshot of the last frame (default false)'),
  },
}, wrap(async (a) => {
  const r = await session.step({ ...a, frames: a.frames ?? 60 });
  const out = [text(r)];
  if (a.screenshot) out.push(image(await session.screenshot()));
  return out;
}));

server.registerTool('game_run', {
  title: 'Run a scenario / sweep',
  description: 'Run a whole scenario in one call: a list of steps, each {input: [...]} (as game_input), {eval: "js"} or {step: {...}} (as game_step), then evaluate "result". With sweep {name, values}, the game is reopened fresh (same seed, so identical start state) before EACH value and "$name" inside any string is replaced by that value (a string that is exactly "$name" becomes the raw value, so numbers stay numbers). Returns one row per value. Use it to test hypotheses like "which frame rates / start positions trigger the bug" in a single call.',
  inputSchema: {
    steps: z.array(z.object({
      input: z.array(z.any()).optional(),
      eval: z.string().optional(),
      step: z.object({
        frames: z.union([z.number().int(), z.string()]).optional(), dt: z.union([z.number(), z.string()]).optional(), hold: Hold, look: Look,
        watch: z.array(z.string()).optional(), every: z.number().int().optional(), until: z.string().optional(),
      }).optional(),
    })),
    result: z.string().optional().describe('JS expression evaluated at the end, e.g. "[player.deaths, player.y]"'),
    sweep: z.object({ name: z.string(), values: z.array(z.any()).min(1).max(100) }).optional(),
    reload: z.boolean().optional().describe('Reopen fresh before running. Default: true with sweep, false without'),
  },
}, wrap(async (a) => [text(await session.run(a))]));

server.registerTool('game_screenshot', {
  title: 'Screenshot',
  description: 'Capture the current frame (canvas + HTML UI). Does not advance time.',
  inputSchema: { scale: z.number().min(0.1).max(1).optional().describe('Default 0.6') },
}, wrap(async ({ scale }) => [image(await session.screenshot({ scale }))]));

server.registerTool('game_filmstrip', {
  title: 'Filmstrip',
  description: 'Advance N frames and return ONE image: a grid of evenly spaced frames labelled with frame numbers. Use it to see motion, animation and physics over time in a single look. Same hold/look/watch options as game_step.',
  inputSchema: {
    frames: z.number().int().min(1).max(36000).optional().describe('Total frames, default 120'),
    shots: z.number().int().min(2).max(24).optional().describe('Tiles, default 8'),
    cols: z.number().int().min(1).max(8).optional().describe('Default 4'),
    scale: z.number().min(0.1).max(1).optional().describe('Tile scale, default 0.3'),
    hold: Hold, look: Look, dt: z.number().optional(),
    watch: z.array(z.string()).optional().describe('Values reported at each tile'),
  },
}, wrap(async (a) => {
  const { sheet, summary } = await session.filmstrip({ ...a, frames: a.frames ?? 120 });
  return [text(summary), image(sheet)];
}));

server.registerTool('game_eval', {
  title: 'Evaluate JS',
  description: 'Run JavaScript in the game page and return the result, trimmed to a readable size (cycles cut, functions dropped, depth limited). An expression returns its value; statements run as an async function body (use return). Does not advance time.',
  inputSchema: {
    code: z.string(),
    depth: z.number().int().min(0).max(6).optional().describe('Object depth, default 3'),
  },
}, wrap(async ({ code, depth }) => [text(await session.eval(code, depth))]));

server.registerTool('game_logs', {
  title: 'Logs',
  description: 'Console messages, uncaught page errors, failed requests and HTTP errors since open (last 80).',
  inputSchema: {
    types: z.array(z.string()).optional().describe('Filter, e.g. ["error","pageerror","requestfailed","http","warning","log"]'),
    clear: z.boolean().optional(),
  },
}, wrap(async (a) => [text(session.getLogs(a))]));

server.registerTool('game_realtime', {
  title: 'Run in real time',
  description: 'running: true lets the game run on the real clock (like a normal browser) until you call this again with false or call game_step, which pauses it.',
  inputSchema: { running: z.boolean() },
}, wrap(async ({ running }) => [text(await session.setRunning(running))]));

server.registerTool('game_close', {
  title: 'Close',
  description: 'Close the browser.',
  inputSchema: {},
}, wrap(async () => { await session.close(); return [text('closed')]; }));

const shutdown = async () => { await session.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
console.error('gameprobe MCP server ready');
