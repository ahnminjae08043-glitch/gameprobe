// gameprobe for Unity: a tiny TCP server inside the game that lets an agent hold the game between frames,
// advance it an exact number of frames at a fixed delta time, read/write any value, inject input and grab frames.
//
// Off unless the player is started with  -gameprobe-port <port>  (or the GAMEPROBE_PORT environment variable),
// so it costs nothing in normal builds.
//
// How the pause works: a system inserted at the very start of Unity's player loop blocks the main thread
// until the agent asks for frames. While blocked it keeps serving read/write requests, and keeps the Windows
// message queue looked at so the window is not reported as "not responding".
using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using UnityEngine;
using UnityEngine.LowLevel;
#if UNITY_EDITOR
using UnityEditor;
#endif

namespace GameProbe
{
    public class GameProbeServer : MonoBehaviour
    {
        struct GameProbeGate { }

        class Request { public Dictionary<string, object> body; public object id; }

        static GameProbeServer instance;
        static TcpListener listener;
        static TcpClient client;
        static StreamWriter writer;
        static readonly object writeLock = new object();
        static readonly ConcurrentQueue<Request> inbox = new ConcurrentQueue<Request>();
        static readonly AutoResetEvent wake = new AutoResetEvent(false);
        static readonly List<string> logs = new List<string>();
        static readonly object logLock = new object();

        static bool running;          // real-time mode: do not block
        static int framesLeft;        // frames still to run for the current step
        static Request current;       // the step being run
        static int stepFrames, stepRan;
        static List<string> stepReads;
        static List<object> stepSeries;
        static int readEvery = 1;
        static bool wantCapture;
        static int captureWidth;
        static Texture2D lastFrame;
        static int seed = 1;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        static void Boot()
        {
            int port = PortFromArgs();
            if (port <= 0) return;
            seed = IntArg("-gameprobe-seed", 1);
            UnityEngine.Random.InitState(seed);
            Application.runInBackground = true;
            QualitySettings.vSyncCount = 0;
            Application.targetFrameRate = -1;
            InputDriver.Init();
            Application.logMessageReceivedThreaded += (msg, stack, type) =>
            {
                lock (logLock)
                {
                    logs.Add(type + ": " + msg + (type == LogType.Exception || type == LogType.Error ? "\n" + Trim(stack, 400) : ""));
                    if (logs.Count > 300) logs.RemoveRange(0, logs.Count - 300);
                }
            };

            var go = new GameObject("[gameprobe]");
            go.hideFlags = HideFlags.HideInHierarchy;
            DontDestroyOnLoad(go);
            instance = go.AddComponent<GameProbeServer>();

            InsertGate();
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            Application.quitting += Shutdown;
#if UNITY_EDITOR
            EditorApplication.update += Drain;   // keeps serving while the editor is paused
            Debug.Break();                        // start paused after the first frame, like a build
#endif
            new Thread(AcceptLoop) { IsBackground = true, Name = "gameprobe" }.Start();
            Debug.Log("[gameprobe] listening on 127.0.0.1:" + port);
        }

        // In the editor the main thread cannot be blocked (the whole editor would freeze), so play mode uses
        // the editor's own pause: paused while the agent thinks, unpaused for exactly N frames, Debug.Break after.
        static bool EditorMode => Application.isEditor;

        static int PortFromArgs()
        {
#if UNITY_EDITOR
            if (EditorPrefs.GetBool("gameprobe.enabled", false)) return EditorPrefs.GetInt("gameprobe.port", 47777);
#endif
            int p = IntArg("-gameprobe-port", 0);
            if (p > 0) return p;
            var env = Environment.GetEnvironmentVariable("GAMEPROBE_PORT");
            return int.TryParse(env, out p) ? p : 0;
        }

        static int IntArg(string name, int dflt)
        {
            var args = Environment.GetCommandLineArgs();
            for (int i = 0; i < args.Length - 1; i++) if (args[i] == name && int.TryParse(args[i + 1], out int v)) return v;
            return dflt;
        }

        // Exiting play mode: free the port (play mode without domain reload keeps statics alive)
        static void Shutdown()
        {
#if UNITY_EDITOR
            EditorApplication.update -= Drain;
#endif
            try { listener?.Stop(); } catch { }
            lock (writeLock) { try { client?.Close(); } catch { } client = null; writer = null; }
            listener = null;
            running = true;
            Time.captureDeltaTime = 0;
        }

        static string Trim(string s, int n) => s == null ? "" : s.Length > n ? s.Substring(0, n) : s;

        // ---------- network (background thread) ----------
        static void AcceptLoop()
        {
            while (true)
            {
                TcpClient c;
                try { c = listener.AcceptTcpClient(); } catch { return; }
                c.NoDelay = true;
                lock (writeLock) { try { client?.Close(); } catch { } client = c; writer = new StreamWriter(c.GetStream(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" }; }
                var reader = new StreamReader(c.GetStream(), new UTF8Encoding(false));
                try
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        if (line.Length == 0) continue;
                        var body = (Dictionary<string, object>)MiniJson.Parse(line);
                        inbox.Enqueue(new Request { body = body, id = body.TryGetValue("id", out var id) ? id : null });
                        wake.Set();
                    }
                }
                catch { }
                // controller went away: never leave the game frozen
                running = true;
                wake.Set();
            }
        }

        static void Reply(Request r, Dictionary<string, object> res)
        {
            res["id"] = r.id;
            var s = MiniJson.Serialize(res);
            lock (writeLock) { try { writer?.WriteLine(s); } catch { } }
        }

        // ---------- the gate (main thread, start of every frame) ----------
        static void InsertGate()
        {
            var loop = PlayerLoop.GetCurrentPlayerLoop();
            for (int i = 0; i < loop.subSystemList.Length; i++)
            {
                if (loop.subSystemList[i].type != typeof(UnityEngine.PlayerLoop.Initialization)) continue;
                var subs = loop.subSystemList[i].subSystemList.ToList();
                subs.Insert(0, new PlayerLoopSystem { type = typeof(GameProbeGate), updateDelegate = Gate });
                loop.subSystemList[i].subSystemList = subs.ToArray();
            }
            PlayerLoop.SetPlayerLoop(loop);
        }

        static void Gate()
        {
            Drain();
            if (!running && framesLeft <= 0 && !EditorMode)
            {
                // hold the game here until the agent asks for frames
                while (!running && framesLeft <= 0)
                {
                    wake.WaitOne(10);
                    Drain();
                    KeepWindowAlive();
                }
            }
            if (framesLeft > 0) framesLeft--;
            InputDriver.BeginFrame();
        }

        static void Drain()
        {
            while (inbox.TryDequeue(out var r))
            {
                try { Handle(r); }
                catch (Exception e) { Reply(r, new Dictionary<string, object> { { "error", e.InnerException?.Message ?? e.Message } }); }
            }
        }

#if UNITY_STANDALONE_WIN && !UNITY_EDITOR
        [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr w, l; public uint time; public int x, y; }
        [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint min, uint max, uint remove);
        // Looking at the queue (without removing anything) is enough for Windows to consider the window responsive.
        static void KeepWindowAlive() { PeekMessage(out _, IntPtr.Zero, 0, 0, 0 /*PM_NOREMOVE*/); }
#else
        static void KeepWindowAlive() { }
#endif

        // ---------- end of every frame ----------
        void Start() { StartCoroutine(EndOfFrames()); }

        IEnumerator EndOfFrames()
        {
            var eof = new WaitForEndOfFrame();
            while (true)
            {
                yield return eof;
                if (current == null) continue;
                stepRan++;
                if (stepReads.Count > 0 && (stepRan % readEvery == 0 || framesLeft <= 0))
                    stepSeries.Add(new List<object> { Time.frameCount, ReadAll(stepReads) });
                if (framesLeft > 0) continue;
                Capture();
                var res = new Dictionary<string, object> { { "frame", Time.frameCount }, { "time", Math.Round(Time.time, 5) }, { "framesRun", stepRan } };
                if (stepReads.Count > 0) res["series"] = stepSeries;
                if (wantCapture) { res["jpeg"] = Jpeg(captureWidth); res["captureMethod"] = captureMethod; }
                var r = current; current = null;
                if (EditorMode && !running) Debug.Break();   // pause the editor right after this frame
                Reply(r, res);
            }
        }

        static List<object> ReadAll(List<string> paths)
        {
            var vals = new List<object>(paths.Count);
            foreach (var p in paths)
            {
                try { vals.Add(Paths.Snapshot(Paths.Get(p))); }
                catch (Exception e) { vals.Add("ERR " + (e.InnerException?.Message ?? e.Message)); }
            }
            return vals;
        }

        // Screen capture differs by graphics API: CaptureScreenshotAsTexture comes back black on D3D12 in some
        // versions. Copy the back buffer into a render texture (flipping where the API stores it upside down),
        // and if that is still black, render the cameras ourselves (UI drawn with OnGUI is then missing).
        static string captureMethod = "screen";
        static bool loggedBlack;
        static void Capture()
        {
            int w = Screen.width, h = Screen.height;
            var rt = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32);
            ScreenCapture.CaptureScreenshotIntoRenderTexture(rt);
            var tex = ReadRT(rt, SystemInfo.graphicsUVStartsAtTop);
            RenderTexture.ReleaseTemporary(rt);
            captureMethod = "screen";
            if (IsBlack(tex))
            {
                if (!loggedBlack)
                {
                    loggedBlack = true;
                    var mid = tex.GetPixel(tex.width / 2, tex.height / 2);
                    Debug.Log("[gameprobe] screen copy black: " + w + "x" + h + " rt " + tex.width + "x" + tex.height + " mid " + mid + " uvTop " + SystemInfo.graphicsUVStartsAtTop + " api " + SystemInfo.graphicsDeviceType + " frame " + Time.frameCount);
                }
                Destroy(tex);
                tex = RenderCameras(w, h);
                captureMethod = "cameras";
            }
            if (lastFrame) Destroy(lastFrame);
            lastFrame = tex;
        }

        static Texture2D ReadRT(RenderTexture src, bool flip)
        {
            var prev = RenderTexture.active;
            RenderTexture read = src;
            if (flip)
            {
                read = RenderTexture.GetTemporary(src.width, src.height, 0, RenderTextureFormat.ARGB32);
                Graphics.Blit(src, read, new Vector2(1, -1), new Vector2(0, 1));
            }
            RenderTexture.active = read;
            var tex = new Texture2D(src.width, src.height, TextureFormat.RGB24, false);
            tex.ReadPixels(new Rect(0, 0, src.width, src.height), 0, 0);
            tex.Apply();
            RenderTexture.active = prev;
            if (read != src) RenderTexture.ReleaseTemporary(read);
            return tex;
        }

        static Texture2D RenderCameras(int w, int h)
        {
            var rt = RenderTexture.GetTemporary(w, h, 24, RenderTextureFormat.ARGB32);
            var cams = Camera.allCameras.Where(c => c.enabled && c.targetTexture == null).OrderBy(c => c.depth).ToList();
            foreach (var cam in cams)
            {
                var old = cam.targetTexture;
                cam.targetTexture = rt;
                cam.Render();
                cam.targetTexture = old;
            }
            var tex = ReadRT(rt, false);
            RenderTexture.ReleaseTemporary(rt);
            return tex;
        }

        static bool IsBlack(Texture2D t)
        {
            for (int i = 1; i < 8; i++) for (int j = 1; j < 8; j++)
            {
                var c = t.GetPixel(t.width * i / 8, t.height * j / 8);
                if (c.r + c.g + c.b > 0.02f) return false;
            }
            return true;
        }

        static string Jpeg(int maxWidth)
        {
            if (!lastFrame) return null;
            var src = lastFrame;
            Texture2D outTex = src;
            if (maxWidth > 0 && src.width > maxWidth)
            {
                int h = Mathf.RoundToInt(src.height * (float)maxWidth / src.width);
                var rt = RenderTexture.GetTemporary(maxWidth, h, 0);
                Graphics.Blit(src, rt);
                var prev = RenderTexture.active; RenderTexture.active = rt;
                outTex = new Texture2D(maxWidth, h, TextureFormat.RGB24, false);
                outTex.ReadPixels(new Rect(0, 0, maxWidth, h), 0, 0); outTex.Apply();
                RenderTexture.active = prev; RenderTexture.ReleaseTemporary(rt);
            }
            var bytes = outTex.EncodeToJPG(75);
            if (outTex != src) Destroy(outTex);
            return Convert.ToBase64String(bytes);
        }

        // ---------- commands (main thread) ----------
        static List<string> Strings(object o) => o is List<object> l ? l.Select(x => x?.ToString()).ToList() : null;
        static double Num(Dictionary<string, object> b, string k, double d) => b.TryGetValue(k, out var v) && v != null ? Convert.ToDouble(v) : d;
        static Vector2? Vec(object o) => o is Dictionary<string, object> d ? new Vector2(Convert.ToSingle(d.TryGetValue("x", out var x) ? x ?? 0 : d.TryGetValue("dx", out var dx) ? dx ?? 0 : 0), Convert.ToSingle(d.TryGetValue("y", out var y) ? y ?? 0 : d.TryGetValue("dy", out var dy) ? dy ?? 0 : 0)) : (Vector2?)null;

        static void Handle(Request r)
        {
            var b = r.body;
            string cmd = b.TryGetValue("cmd", out var c) ? c as string : "";
            switch (cmd)
            {
                case "hello":
                    Reply(r, new Dictionary<string, object> {
                        { "unity", Application.unityVersion }, { "product", Application.productName }, { "scene", UnityEngine.SceneManagement.SceneManager.GetActiveScene().name },
                        { "inputSystem", InputDriver.Available }, { "frame", Time.frameCount }, { "seed", seed }, { "screen", new List<object> { Screen.width, Screen.height } },
                        { "editor", Application.isEditor }, { "port", ((IPEndPoint)listener.LocalEndpoint).Port } });
                    return;

                case "step":
                {
                    if (current != null) throw new Exception("a step is already running");
                    if (b.TryGetValue("input", out var inp) && inp is Dictionary<string, object> input)
                    {
                        Vector2? look = input.ContainsKey("look") ? Vec(input["look"]) ?? Vector2.zero : (Vector2?)null;
                        InputDriver.Set(input.ContainsKey("keys") ? Strings(input["keys"]) : null, input.ContainsKey("buttons") ? Strings(input["buttons"]) : null, look, Vec(input.TryGetValue("pointer", out var pt) ? pt : null));
                    }
                    stepFrames = Math.Max(1, (int)Num(b, "frames", 1));
                    double dt = Num(b, "dt", 1000.0 / 60);
                    Time.captureDeltaTime = (float)(dt / 1000.0);
                    stepReads = Strings(b.TryGetValue("read", out var rd) ? rd : null) ?? new List<string>();
                    readEvery = Math.Max(1, (int)Num(b, "every", 1));
                    stepSeries = new List<object>();
                    wantCapture = b.TryGetValue("capture", out var cap) && cap is true;
                    captureWidth = (int)Num(b, "maxWidth", 0);
                    stepRan = 0;
                    current = r;
                    running = false;
                    framesLeft = stepFrames;
#if UNITY_EDITOR
                    EditorApplication.isPaused = false;
#endif
                    return;
                }

                case "read":
                    Reply(r, new Dictionary<string, object> { { "values", ReadAll(Strings(b["paths"])) } });
                    return;

                case "set":
                    Paths.Set((string)b["path"], b["value"]);
                    Reply(r, new Dictionary<string, object> { { "value", Paths.Snapshot(Paths.Get((string)b["path"])) } });
                    return;

                case "call":
                    var ret = Paths.Call((string)b["path"], b.TryGetValue("args", out var a) && a is List<object> al ? al : new List<object>());
                    Reply(r, new Dictionary<string, object> { { "value", Paths.Snapshot(ret, (int)Num(b, "depth", 2)) } });
                    return;

                case "inspect":
                    Reply(r, new Dictionary<string, object> { { "value", Paths.Snapshot(Paths.Get((string)b["path"]), (int)Num(b, "depth", 2)) } });
                    return;

                case "tree":
                    Reply(r, new Dictionary<string, object> { { "tree", Paths.Tree((int)Num(b, "depth", 2), b.TryGetValue("root", out var root) ? root as string : null) } });
                    return;

                case "capture":
                    Reply(r, new Dictionary<string, object> { { "jpeg", Jpeg((int)Num(b, "maxWidth", 0)) } });
                    return;

                case "logs":
                    lock (logLock)
                    {
                        var copy = logs.Skip(Math.Max(0, logs.Count - 80)).ToList();
                        if (b.TryGetValue("clear", out var cl) && cl is true) logs.Clear();
                        Reply(r, new Dictionary<string, object> { { "logs", copy } });
                    }
                    return;

                case "realtime":
                    running = b.TryGetValue("running", out var run) && run is true;
                    if (running) Time.captureDeltaTime = 0;
#if UNITY_EDITOR
                    EditorApplication.isPaused = !running;
#endif
                    Reply(r, new Dictionary<string, object> { { "running", running }, { "frame", Time.frameCount } });
                    return;

                case "quit":
                    Reply(r, new Dictionary<string, object> { { "ok", true } });
                    running = true;
                    Application.Quit();
                    return;

                default:
                    throw new Exception("unknown cmd " + cmd);
            }
        }
    }
}
