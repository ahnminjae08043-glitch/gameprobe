# gameprobe

**Let your coding agent actually play the game it just wrote.**

Claude Code, Codex, Cursor and friends can write a whole web game in minutes, but they can't see it, can't
play it, and can't tell you that the player falls through the floor on a slow laptop. gameprobe is an MCP
server that gives them eyes, hands and a pause button for any browser game (canvas, WebGL, three.js, Phaser,
PixiJS, ...), **without touching the game's code**.

**[Watch the 30 s demo](https://github.com/ahnminjae08043-glitch/gameprobe/blob/main/docs/gameprobe-demo.webm)**: a bug only slow machines see, an agent coaching its own
controller to a frame-perfect run, a Unity bug caught by path, and a 52 m first-person climb. Every frame in it
was captured by stepping gameprobe's virtual time.

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

## Human speed: the agent coaches, code plays

An LLM needs seconds per decision, far too slow to play anything in real time. So it doesn't. With `game_control`
the agent writes a small controller (a JS function) and gameprobe runs it **every frame** inside the game. The agent
watches the result (log, watched values, filmstrip), fixes the code and reruns. Time is virtual, so every attempt
from `reset: true` is identical, and a fix can be checked down to a single frame.

```js
// game_control { reset: true, until: "game.coin.taken && game.player.x <= 40", policy: ... }
const p = game.player;
if (!ctx.mem.got && game.coin.taken) ctx.mem.got = true;
if (ctx.mem.got) return { keys: ['ArrowLeft'] };
return { keys: p.onGround && p.x > 730 ? ['ArrowRight', 'Space'] : ['ArrowRight'] };
```

A blind agent that had never seen the demo platformer got the coin and came home in **5 attempts**:

| Attempt | What changed | Result |
|---|---|---|
| 1 | jump at the right edge of every platform | hit its head under the top platform, died (found in the log) |
| 2 | jump earlier on platform 4 | coin and home, 6.43 s |
| 3–4 | time the coin hop one frame earlier each time | **6.37 s, 0 deaths** |
| 5 | one more frame earlier | missed the coin, so it went back to attempt 4 |

The agent worked out that 6.37 s is the floor: a 827.7 px round trip at 260 px/s, 382 frames, none wasted.
The same controller also finished unchanged at 30 fps.

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
| `game_control` | Run your controller every frame (keys / buttons / look from game state). Human speed and faster. Web and Unity. |
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
claude mcp add gameprobe -- npx -y gameprobe
```

Any MCP client works: the server is `npx -y gameprobe` over stdio.

Unity: Package Manager → *Add package from git URL* →
`https://github.com/ahnminjae08043-glitch/gameprobe.git?path=unity/com.gameprobe.unity`

Then ask your agent something like *"open my game in ./game with gameprobe and check that the player can't
fall through platforms at low frame rates"*.

## Unity

Add the package and your game becomes as controllable as a web game: held between frames inside the engine,
advanced an exact number of frames at a fixed delta time, every value readable by path, input fed straight into
the Input System.

1. Package Manager → *Add package from git URL* (or `file:` path) → `com.gameprobe.unity`
2. Build as usual. The package does nothing unless the player is started with `-gameprobe-port <port>`,
   which gameprobe does for you.
3. `game_open { exe: "Build/MyGame.exe" }`. Unity builds are detected automatically.

Read and write the game by path:

```
"Player.transform.position.y"          GameObject → member
"Player.PlayerController.grounded"     component by type name → field (private too)
"#GameManager.score"                   first active object of a type
"GameManager.Instance.score"           static member
"[Main Camera].transform.position"     names with spaces
```

`watch` / `until` / `game_control` take a path or a JS expression with `$("path")`. `game_eval` has `$tree()`,
`$inspect(path)`, `$set(path, value)` and `$call(path, ...args)` for exploring and poking.

**Blind test.** We built a small 3D coin game (`unity/TestGame`) with one planted bug: the player has a second
"feet" collider, so a coin touched by both counts twice. An agent that had never seen the project found it, then
**proved the cause by toggling the feet collider in a sweep** (+2 with it on, +1 with it off). It also found two
bugs we had not planted:

| Bug | Evidence the agent produced |
|---|---|
| Coin counted twice (planted) | score 9 after 5 coins; sweep `Feet.enabled` true/false gives +2/+1 |
| Mid-air re-jumps | mashing Space chained 4 jumps in one rise; `grounded` stays true up to 0.7 m above the floor |
| Sticking to walls | holding W into a platform side hangs the player for 5+ s; setting friction to 0 removes it |

Notes:
- Same machine, same inputs, same result. Unity physics is not guaranteed bit-identical across different CPUs.
- Input works through the Input System package. The legacy `Input.GetKey` manager cannot be driven.
- In some built players the back buffer cannot be read; screenshots then fall back to rendering the cameras and
  `OnGUI` text is missing from images (it is captured in the Editor). Read those values by path instead.
- In the Editor: **Tools > gameprobe > Enable in Play Mode**, press Play, then `game_open { unity: 47777 }`.
  Play mode starts paused and uses the editor's own pause between steps, so the editor stays usable.

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
- Native mode is Windows only and sees the game only through the screen. Unity has a plugin; Godot is next.

## Development

```bash
npm test                         # controller, determinism and fps sweep on the bundled demo game
unity/build-testgame.sh          # build the Unity test game (needs Unity 6), then node test/unity-mcp.mjs
```

MIT
