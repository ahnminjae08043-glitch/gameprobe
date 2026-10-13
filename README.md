# gameprobe

**Let your coding agent actually play the game it just wrote.**

Claude Code, Codex, Cursor and friends can write a whole web game in minutes, but they can't see it, can't
play it, and can't tell you that the player falls through the floor on a slow laptop. gameprobe is an MCP
server that gives them eyes, hands and a pause button for any browser game (canvas, WebGL, three.js, Phaser,
PixiJS, ...), **without touching the game's code**.

## Proof: a blind agent found a bug it was never told about

`examples/buggy-platformer` has one planted bug. An agent that had never seen the source, using only
gameprobe's tools, reported (condensed):

> **Bug 1: at 30 fps or lower the player passes through the thin green bridge and dies.**
> Repro: `game_eval` to place the player above the bridge, then `game_step {frames: 30, dt: 33.333}`. The player
> goes straight past y=470 and `deaths` goes up. The same steps with `dt` 16.667 / 20 / 25 land every time.
> Likely cause: collision only checks overlap, with no sweep. The fall per frame (28–50 px) is larger than
> the overlap window (24 px player + 4 px bridge).

It also found three real bugs we had *not* planted: no world bounds, the whole game slowing down below 30 fps,
and jump height depending on frame rate. All of them were confirmed with numbers, not screenshots.
(See [`SPOILER.md`](examples/buggy-platformer/SPOILER.md).)

With `game_run`, the planted bug fits in one call:

```
game_run { sweep: { name: "fps", values: [144, 60, 45, 30, 20] }, steps: [...walk off the tower...],
           result: "({ died: game.player.deaths > 0 })" }

fps 144 → landed   fps 60 → landed   fps 45 → landed   fps 30 → DIED   fps 20 → DIED
```

## How it works

| Problem | What gameprobe does |
|---|---|
| Games run on wall-clock time, so every run differs and things happen between the agent's calls | **Virtual time.** `requestAnimationFrame`, `performance.now` and `Date.now` are replaced. The game is paused and advances only when the agent steps it, at any `dt` (simulate 144 fps or a 20 fps laptop). `Math.random` is seeded. Same inputs, bit-identical state. |
| Hidden tabs and headless browsers throttle or stop `requestAnimationFrame` (black canvas) | Frames are driven by gameprobe, not the browser's vsync. |
| Pointer-lock games (FPS, flight, climbing) refuse to run headless | Pointer lock is emulated. `look {dx, dy}` feeds `movementX/Y`. |
| Screenshots are an expensive and imprecise way to read state | **`watch`** any JS expression every frame and get back a compact series (first/last/min/max + samples, or value changes). **`until`** stops on the frame a condition becomes true. |
| One screenshot can't show motion | **`game_filmstrip`**: N frames in one labelled grid image. |
| Headless WebGL is slow or broken | It uses your installed Chrome/Edge, so you get your real GPU and download no browser. |

## Tools

| Tool | Purpose |
|---|---|
| `game_open` | Open a folder (served for you, no cache) or a URL. Starts paused. |
| `game_step` | Advance N frames at `dt`, holding keys/buttons, moving the view, with `watch` / `until`. |
| `game_run` | A whole scenario in one call. Add `sweep` to rerun it from a fresh, identical state for each value. |
| `game_input` | One-off key / mouse / text / wheel / look events (trusted events, not synthetic). |
| `game_filmstrip` | Grid image of frames over time. |
| `game_screenshot` | The current frame, including HTML UI. |
| `game_eval` | Read or poke game state. Results are trimmed to a readable size (cycles cut, depth limited). |
| `game_logs` | Console errors, uncaught exceptions, failed requests, HTTP errors, and exceptions thrown inside frames. |
| `game_realtime` | Let it run on the real clock like a normal browser. |

## Setup

Requires Node 18+ and Chrome or Edge installed (Edge ships with Windows). Without either, run
`npx playwright install chromium` once.

```bash
git clone https://github.com/ahnminjae08043-glitch/gameprobe && cd gameprobe && npm install
claude mcp add gameprobe -- node /absolute/path/to/gameprobe/src/server.js
```

Any MCP client works. The command is `node /absolute/path/to/gameprobe/src/server.js` over stdio.

Then ask your agent something like *"open my game in ./game with gameprobe and check that the player can't
fall through platforms at low frame rates"*.

## Any game, any engine (native mode, Windows)

Not a web game? Point gameprobe at the executable, or at a window that is already open:

```
game_open { exe: "C:/Games/MyGame/MyGame.exe" }     # launch
game_open { window: "MyGame" }                      # attach to a running game
```

There is no way to look inside a compiled game from the outside, so native mode trades internals for the screen:

| | Web mode | Native mode |
|---|---|---|
| Time | virtual, deterministic | real, but the game process is **frozen between your calls** (suspended), so nothing happens while the agent thinks |
| Input | browser events | OS scancodes and mouse (raw-input games accept them) |
| State | `watch` / `until` on JS values | `untilScreen`: stop when the screen, or one cell of it, changes or turns a colour |
| Reset / sweeps | `game_run` | not available |

Tested on an Unreal Engine D3D12 game. It went through the main menu, save slots, weapon selection and story
screen with the keyboard, then walked and turned the camera. The game's own tutorial checklist ticked "movement"
and "camera". Things learned the hard way:

- Many engine UIs ignore synthetic mouse clicks on menus. Use the keyboard (Enter / arrows).
- The helper is a small C# program compiled on first use with the `csc.exe` that ships with Windows. Nothing to install.
- **Games with anti-cheat are refused** (EasyAntiCheat, BattlEye, Vanguard, ...). Injecting input into them or
  suspending them can get an account banned.
- Native input moves the real mouse and keyboard while a step runs. Don't use the PC at the same time.

## Watch it play

Spectator mode opens a real window, paces the frames in real time and captions what the agent is doing.
The results are exactly the same as headless runs.

```bash
GAMEPROBE_VISIBLE=1 claude                 # every game_open in this session becomes watchable
```

or pass `visible: true` (and `speed: 0.5` for slow motion) to `game_open`.

## Limits (v0.1)

- `setTimeout` / `setInterval` still run on real time. Games that drive gameplay with timers are not fully
  deterministic yet.
- Web Audio is not virtualized.
- Native mode is Windows only and sees the game only through the screen. Engine plugins (Godot, Unity) that expose
  internals and deterministic time are on the roadmap.

## Development

```bash
npm test                      # MCP end-to-end + determinism (uses a three.js game next to this repo)
node test/sweep.mjs           # the fps sweep on the demo game
```

MIT
