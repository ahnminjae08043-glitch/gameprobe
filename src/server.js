#!/usr/bin/env node
// gameprobe MCP 서버 (stdio). stdout은 MCP 프로토콜 전용이므로 로그는 stderr로만 쓴다.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Session } from './session.js';
import { NativeSession } from './native.js';
import { UnitySession } from './unity.js';
import fs from 'node:fs';
import nodePath from 'node:path';

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
through the floor) rather than eyeballing screenshots.

UNITY MODE (Unity builds with the com.gameprobe.unity package): game_open {exe} detects it. The game is held inside the
engine between calls and advances exactly N frames at a fixed dt, like web mode. State is read by PATH instead of JS:
"Player.transform.position.y", "Player.PlayerController.grounded" (component by type name), "#GameManager.score"
(first object of a type), "GameManager.Instance.score" (static), "[Main Camera].transform.position" (names with spaces).
watch/until take a path or a JS expression using $("path"). game_eval runs JS with await-able helpers: $(path),
$set(path, value), $call(path, ...args), $inspect(path), $tree(depth, root). Start with game_eval "$tree()".
Input goes into the Input System (KeyW, Space, ArrowUp, mouse buttons, look) without touching the real mouse.
game_input key press / mouse click are applied on the next stepped frame.

NATIVE MODE (any engine: Unity/Unreal/Godot builds, any Windows game): game_open {exe} launches it, or {window: "title regex"}
attaches to a running one. There is no access to internals, so: time is real but the process is FROZEN between your
calls and runs only during game_step (use ms); state comes from the screen (screenshots, filmstrip, and
untilScreen {region, change} or {region, color} to stop when part of the screen changes). game_eval and game_run
are unavailable. Input is real OS input (scancodes), so it also moves the user's actual mouse. Use
the controls the game expects: some games navigate menus only with the keyboard (Enter / arrows). Never touch games with anti-cheat.`;

// 열린 게임 종류에 따라 웹 세션 또는 네이티브 세션을 쓴다. 도구는 같다.
const web = new Session();
const native = new NativeSession();
const unity = new UnitySession();
let session = web;

// exe 옆에 UnityPlayer.dll 과 <이름>_Data 폴더가 있으면 Unity 빌드다
function isUnityBuild(exe) {
  const dir = nodePath.dirname(exe), base = nodePath.basename(exe, nodePath.extname(exe));
  return fs.existsSync(nodePath.join(dir, 'UnityPlayer.dll')) && fs.existsSync(nodePath.join(dir, base + '_Data'));
}
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
  description: 'Open a game. Web: give dir (served for you) or url; runs in a headless browser with virtual time. Native (any engine, Windows): give exe to launch, or window (title/exe regex) or pid to attach; the process is frozen between calls. Closes any previously open game. Starts paused.',
  inputSchema: {
    exe: z.string().optional().describe('Path to a game executable. Unity builds containing the gameprobe package open in Unity mode (frame-exact, state by path); anything else opens in native mode'),
    mode: z.enum(['auto', 'unity', 'native']).optional().describe('Force a mode for exe (default auto)'),
    unity: z.union([z.string(), z.number()]).optional().describe('Attach to a running Unity game: a build started with -gameprobe-port <port>, or the Editor in play mode with Tools > gameprobe > Enable in Play Mode (default port 47777)'),
    args: z.array(z.string()).optional().describe('Native: command line arguments'),
    window: z.string().optional().describe('Native: attach to a running game whose window title or process name matches this regex'),
    pid: z.number().int().optional().describe('Native: attach to this process id'),
    startupMs: z.number().optional().describe('Native: wait this long after the window appears (splash screens)'),
    keepRunning: z.boolean().optional().describe('Native: leave the game running after game_close (default: close games you launched)'),
    allowAntiCheat: z.boolean().optional().describe('Native: override the anti-cheat refusal. Only for your own game.'),
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
  await web.close(); await native.close(); await unity.close();
  const mode = a.mode || 'auto';
  let info;
  if (a.unity || mode === 'unity' || (mode === 'auto' && a.exe && isUnityBuild(a.exe))) {
    session = unity;
    try {
      info = await unity.open({ ...a, timeoutMs: a.unity ? 5000 : 20000 });
    } catch (e) {
      await unity.close();
      if (!e.noPlugin || mode === 'unity' || a.unity) throw e;
      // Unity 빌드지만 gameprobe 패키지가 없다: 화면 기반 범용 폴백으로 연다
      session = native;
      info = await native.open(a);
      info.notes.unshift('This is a Unity build without the gameprobe package (com.gameprobe.unity), so it opened in native mode. Add the package for frame-exact control and state reading.');
    }
  } else {
    session = a.exe || a.window || a.pid || mode === 'native' ? native : web;
    info = await session.open(a);
  }
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
    ms: z.number().optional().describe('Native: real milliseconds to let the game run (default frames*16.7)'),
    untilScreen: z.object({
      region: z.array(z.number()).length(4).optional().describe('[x, y, w, h] in window pixels, default whole window'),
      change: z.number().optional().describe('Stop when the region as a whole differs from its state at the start by this much (0..1 mean over a 16x16 grid, e.g. 0.1). Good for scene changes'),
      anyChange: z.number().optional().describe('Stop when ANY one cell of the 16x16 grid changes by this much (0..1, e.g. 0.08; an idle screen measures 0). Good for a menu highlight, a line of text or a popup on a dark screen'),
      color: z.string().optional().describe('Stop when the region average colour is within tolerance of this #rrggbb'),
      tolerance: z.number().optional(),
    }).optional().describe('Native: stop as soon as part of the screen changes or turns a colour. Without region, the comparison base is the screen just BEFORE your last game_input (so "press a key, then wait for a reaction" works); otherwise the screen at the start of this step'),
    hold: Hold, look: Look,
    watch: z.array(z.string()).optional().describe('JS expressions evaluated in the page each frame, e.g. "player.x", "game.state", "scene.children.length"'),
    every: z.number().int().optional().describe('Sample watch every N frames (default 1)'),
    samples: z.number().int().min(2).max(200).optional().describe('Max samples kept per numeric watch series (default 12)'),
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
        frames: z.union([z.number().int(), z.string()]).optional(), dt: z.union([z.number(), z.string()]).optional(),
        hold: z.any().optional().describe('As game_step; "$name" may stand for a whole array, e.g. { keys: "$keys" }'), look: z.any().optional(),
        watch: z.array(z.string()).optional(), every: z.number().int().optional(), until: z.string().optional(),
      }).optional(),
    })),
    result: z.string().optional().describe('JS expression evaluated at the end, e.g. "[player.deaths, player.y]"'),
    sweep: z.object({ name: z.string(), values: z.array(z.any()).min(1).max(100) }).optional(),
    reload: z.boolean().optional().describe('Reopen fresh before running. Default: true with sweep, false without'),
  },
}, wrap(async (a) => [text(await session.run(a))]));

server.registerTool('game_control', {
  title: 'Run a controller (reflexes)',
  description: `You are too slow to play in real time (seconds per decision); code is not. Write a controller and gameprobe runs it EVERY FRAME inside the game, before the game's own update. Then look at what happened and improve the code. This is how you play at human speed or faster.

policy is a JS function body. It receives ctx and returns the input state wanted for this frame:
  return { keys: ["ArrowRight", "Space"], buttons: ["left"], look: { dx: 3, dy: 0 } }
Keys/buttons listed are held down; anything not listed is released (keydown/keyup events are generated for you). Read game state from page globals directly (e.g. game.player.x). ctx = { frame (global), i (frames since this controller started), t, dt, mem, held, buttons, log(msg) }: mem persists across frames for your own state machine; log() records up to 200 lines, each tagged with ctx.i (frames since this controller started). When until becomes true the run stops on that frame, after your policy already ran for it.
Example: const p = game.player; if (!ctx.mem.phase) ctx.mem.phase = "run"; if (p.x > 600 && p.onGround) { ctx.log("jump at " + p.x); return { keys: ["ArrowRight", "Space"] }; } return { keys: ["ArrowRight"] };
Runs on virtual time like game_step, so results are deterministic: fix the code and rerun from the same state with reset: true.
UNITY MODE: the policy runs between frames and reads the game through $("path"), e.g. const y = $("Player.transform.position.y"); paths must be string literals (or listed in read). Not available in native mode.`,
  inputSchema: {
    policy: z.string().describe('JS function body; gets ctx, returns { keys?, buttons?, look? }'),
    frames: z.number().int().min(1).max(36000).optional().describe('Default 600 (10 s at 60 fps)'),
    dt: z.number().optional().describe('Milliseconds per frame, default 16.667'),
    until: z.string().optional().describe('Stop when this JS expression is truthy, e.g. "game.coin.taken || game.player.deaths > 0"'),
    watch: z.array(z.string()).optional(), every: z.number().int().optional(),
    samples: z.number().int().min(2).max(200).optional().describe('Max samples per numeric watch series (default 12)'),
    reset: z.boolean().optional().describe('Reopen the game fresh (same seed) before running, so each attempt starts from the identical state'),
    read: z.array(z.string()).optional().describe('Unity mode: extra paths to read every frame when the policy builds paths dynamically'),
    shots: z.number().int().min(0).max(24).optional().describe('Also return a filmstrip: the run is split into this many equal parts and the screen is captured after each. If until stops the run early, fewer tiles are returned (default 0)'),
    cols: z.number().int().min(1).max(8).optional(), scale: z.number().min(0.1).max(1).optional(),
  },
}, wrap(async (a) => {
  if (!session.control) throw new Error('game_control works in web and Unity mode, not native mode');
  const r = await session.control(a);
  if (r.ok === false) return [text(r)];
  const out = [text(r.summary)];
  if (r.sheet) out.push(image(r.sheet));
  return out;
}));

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
    ms: z.number().optional().describe('Native: total real milliseconds to cover'),
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
}, wrap(async (a) => [text(await session.getLogs(a))]));

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

const shutdown = async () => { await unity.close(); await native.close(); await web.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
console.error('gameprobe MCP server ready');
