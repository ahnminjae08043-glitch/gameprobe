// gameprobe native helper for Windows.
// Talks JSON lines over stdin/stdout. Compiled on first use with the csc.exe that ships with
// .NET Framework 4 (present on every Windows 10/11), so users install nothing.
// Written for C# 5 (no string interpolation, no ?. operator) because that is what csc v4 accepts.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

static class Native
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion u; }
    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
    [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
    [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}

static class Helper
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    // Every process we froze. If the controller goes away (stdin closes, crash), they are resumed so a
    // game is never left hanging.
    static readonly HashSet<int> Frozen = new HashSet<int>();

    static void Main()
    {
        Native.SetProcessDPIAware();
        Console.OutputEncoding = new UTF8Encoding(false);
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        Reply(new Dictionary<string, object> { { "ready", true } });
        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            if (line.Trim().Length == 0) continue;
            object id = null;
            try
            {
                var req = (Dictionary<string, object>)Json.DeserializeObject(line);
                if (req.ContainsKey("id")) id = req["id"];
                var res = Handle(req);
                res["id"] = id;
                Reply(res);
            }
            catch (Exception e)
            {
                Reply(new Dictionary<string, object> { { "id", id }, { "error", e.Message } });
            }
        }
        foreach (var pid in new List<int>(Frozen)) SuspendResume(pid, false);
    }

    static void Reply(Dictionary<string, object> o)
    {
        Console.Out.Write(Json.Serialize(o));
        Console.Out.Write("\n");
        Console.Out.Flush();
    }

    static int I(Dictionary<string, object> r, string k, int d) { return r.ContainsKey(k) && r[k] != null ? Convert.ToInt32(r[k]) : d; }
    static double D(Dictionary<string, object> r, string k, double d) { return r.ContainsKey(k) && r[k] != null ? Convert.ToDouble(r[k]) : d; }
    static string S(Dictionary<string, object> r, string k, string d) { return r.ContainsKey(k) && r[k] != null ? Convert.ToString(r[k]) : d; }
    static bool B(Dictionary<string, object> r, string k, bool d) { return r.ContainsKey(k) && r[k] != null ? Convert.ToBoolean(r[k]) : d; }
    static IntPtr H(Dictionary<string, object> r) { return new IntPtr(Convert.ToInt64(r["hwnd"])); }

    static Dictionary<string, object> Handle(Dictionary<string, object> r)
    {
        var res = new Dictionary<string, object>();
        switch (S(r, "cmd", ""))
        {
            case "windows": res["windows"] = Windows(I(r, "pid", 0)); break;
            case "rect": res["rect"] = ClientRect(H(r)); res["alive"] = Native.IsWindow(H(r)); break;
            case "focus": res["focused"] = Focus(H(r)); break;
            case "capture": Capture(H(r), S(r, "method", "auto"), I(r, "maxWidth", 0), I(r, "quality", 75), res); break;
            case "probe": res["probe"] = Probe(H(r), r); break;
            case "key": Key(S(r, "key", ""), B(r, "down", true)); break;
            case "mouse": Mouse(r); break;
            case "suspend": res["ok"] = SuspendResume(I(r, "pid", 0), true); break;
            case "resume": res["ok"] = SuspendResume(I(r, "pid", 0), false); break;
            case "sheet": res["jpeg"] = Sheet(r); break;
            case "ping": res["pong"] = true; break;
            default: throw new Exception("unknown cmd " + S(r, "cmd", ""));
        }
        return res;
    }

    // ---------- windows ----------
    static ArrayList Windows(int pidFilter)
    {
        var list = new ArrayList();
        Native.EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!Native.IsWindowVisible(h)) return true;
            if (Native.GetWindow(h, 4 /*GW_OWNER*/) != IntPtr.Zero) return true;
            var t = new StringBuilder(512); Native.GetWindowText(h, t, 512);
            if (t.Length == 0) return true;
            uint pid; Native.GetWindowThreadProcessId(h, out pid);
            if (pidFilter != 0 && pid != pidFilter) return true;
            var c = new StringBuilder(256); Native.GetClassName(h, c, 256);
            string exe = "";
            try { exe = Process.GetProcessById((int)pid).ProcessName; } catch { }
            var rc = ClientRect(h);
            if (Convert.ToInt32(rc["w"]) < 50 || Convert.ToInt32(rc["h"]) < 50) return true;
            list.Add(new Dictionary<string, object> {
                { "hwnd", h.ToInt64() }, { "title", t.ToString() }, { "pid", (int)pid }, { "exe", exe },
                { "class", c.ToString() }, { "rect", rc }, { "minimized", Native.IsIconic(h) } });
            return true;
        }, IntPtr.Zero);
        return list;
    }

    static Dictionary<string, object> ClientRect(IntPtr h)
    {
        Native.RECT rc; Native.GetClientRect(h, out rc);
        var p = new Native.POINT(); Native.ClientToScreen(h, ref p);
        return new Dictionary<string, object> { { "x", p.X }, { "y", p.Y }, { "w", rc.R - rc.L }, { "h", rc.B - rc.T } };
    }

    // Windows refuses SetForegroundWindow from background processes; attaching to the
    // foreground thread's input queue is the standard workaround.
    static bool Focus(IntPtr h)
    {
        if (Native.IsIconic(h)) Native.ShowWindow(h, 9 /*SW_RESTORE*/);
        var fg = Native.GetForegroundWindow();
        if (fg == h) return true;
        uint dummy;
        uint fgThread = Native.GetWindowThreadProcessId(fg, out dummy);
        uint me = Native.GetCurrentThreadId();
        Native.AttachThreadInput(me, fgThread, true);
        Native.BringWindowToTop(h);
        Native.SetForegroundWindow(h);
        Native.AttachThreadInput(me, fgThread, false);
        Thread.Sleep(30);
        return Native.GetForegroundWindow() == h;
    }

    // ---------- capture ----------
    // PrintWindow with PW_RENDERFULLCONTENT reads the window even when covered, but some
    // DirectX swap chains come back black. Copying from the screen always matches what the
    // player sees, but needs the window to be on top. "auto" tries the first, then the second.
    static Bitmap Grab(IntPtr h, string method, out string used)
    {
        var rc = ClientRect(h);
        int x = Convert.ToInt32(rc["x"]), y = Convert.ToInt32(rc["y"]), w = Convert.ToInt32(rc["w"]), hh = Convert.ToInt32(rc["h"]);
        if (w <= 0 || hh <= 0) throw new Exception("window has no client area (minimized?)");
        // PrintWindow asks the window to paint itself. A frozen (suspended) or hung game never answers
        // and the call blocks forever, so check responsiveness first and fall back to the screen.
        if (method == "auto" && !Responsive(h)) method = "screen";
        if (method == "auto" || method == "print")
        {
            var full = PrintWhole(h);
            if (full != null)
            {
                // PrintWindow draws the whole window including borders: crop to the client area
                Native.RECT wr; GetWindowRectSafe(h, out wr);
                var bmp = new Bitmap(w, hh, PixelFormat.Format24bppRgb);
                using (var g = Graphics.FromImage(bmp)) g.DrawImage(full, new Rectangle(0, 0, w, hh), new Rectangle(x - wr.L, y - wr.T, w, hh), GraphicsUnit.Pixel);
                full.Dispose();
                if (method == "print" || !IsBlank(bmp)) { used = "print"; return bmp; }
                bmp.Dispose();
            }
        }
        var s = new Bitmap(w, hh, PixelFormat.Format24bppRgb);
        using (var g = Graphics.FromImage(s)) g.CopyFromScreen(x, y, 0, 0, new Size(w, hh));
        used = "screen";
        return s;
    }

    static bool Responsive(IntPtr h)
    {
        IntPtr r;
        return Native.SendMessageTimeout(h, 0 /*WM_NULL*/, IntPtr.Zero, IntPtr.Zero, 0x0002 /*SMTO_ABORTIFHUNG*/, 200, out r) != IntPtr.Zero;
    }

    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Native.RECT r);
    static void GetWindowRectSafe(IntPtr h, out Native.RECT r) { GetWindowRect(h, out r); }

    static Bitmap PrintWhole(IntPtr h)
    {
        Native.RECT wr; GetWindowRect(h, out wr);
        int w = wr.R - wr.L, hh = wr.B - wr.T;
        if (w <= 0 || hh <= 0) return null;
        var bmp = new Bitmap(w, hh, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            IntPtr hdc = g.GetHdc();
            bool ok = Native.PrintWindow(h, hdc, 2 /*PW_RENDERFULLCONTENT*/);
            g.ReleaseHdc(hdc);
            if (!ok) { bmp.Dispose(); return null; }
        }
        return bmp;
    }

    static bool IsBlank(Bitmap b)
    {
        // sample a grid: an all-black or all-one-colour frame means the capture failed
        int same = 0, n = 0; Color first = b.GetPixel(b.Width / 2, b.Height / 2);
        for (int i = 1; i < 12; i++) for (int j = 1; j < 12; j++)
        {
            var c = b.GetPixel(b.Width * i / 12, b.Height * j / 12); n++;
            if (Math.Abs(c.R - first.R) + Math.Abs(c.G - first.G) + Math.Abs(c.B - first.B) < 6) same++;
        }
        return same == n;
    }

    static void Capture(IntPtr h, string method, int maxWidth, int quality, Dictionary<string, object> res)
    {
        string used;
        var bmp = Grab(h, method, out used);
        Bitmap outBmp = bmp;
        if (maxWidth > 0 && bmp.Width > maxWidth)
        {
            int nh = (int)Math.Round(bmp.Height * (double)maxWidth / bmp.Width);
            outBmp = new Bitmap(maxWidth, nh, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(outBmp))
            {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
                g.DrawImage(bmp, 0, 0, maxWidth, nh);
            }
        }
        var enc = Array.Find(ImageCodecInfo.GetImageEncoders(), delegate (ImageCodecInfo c) { return c.MimeType == "image/jpeg"; });
        var ps = new EncoderParameters(1);
        ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
        using (var ms = new MemoryStream())
        {
            outBmp.Save(ms, enc, ps);
            res["jpeg"] = Convert.ToBase64String(ms.ToArray());
        }
        res["width"] = bmp.Width; res["height"] = bmp.Height; res["method"] = used;
        if (outBmp != bmp) outBmp.Dispose();
        bmp.Dispose();
    }

    // Average colour of a client-area region, plus a 16x16 luminance signature so the caller
    // can tell "this part of the screen changed" without shipping images around.
    static Dictionary<string, object> Probe(IntPtr h, Dictionary<string, object> r)
    {
        string used;
        using (var bmp = Grab(h, S(r, "method", "auto"), out used))
        {
            int x = I(r, "x", 0), y = I(r, "y", 0);
            int w = I(r, "w", bmp.Width - x), hh = I(r, "h", bmp.Height - y);
            x = Math.Max(0, Math.Min(bmp.Width - 1, x)); y = Math.Max(0, Math.Min(bmp.Height - 1, y));
            w = Math.Max(1, Math.Min(bmp.Width - x, w)); hh = Math.Max(1, Math.Min(bmp.Height - y, hh));
            long sr = 0, sg = 0, sb = 0; int n = 0;
            // 16x16 grid: fine enough that a line of text or a highlighted button moves at least one cell
            var sig = new int[256];
            int step = Math.Max(1, Math.Min(w, hh) / 96);
            var counts = new int[256];
            for (int j = 0; j < hh; j += step) for (int i = 0; i < w; i += step)
            {
                var c = bmp.GetPixel(x + i, y + j);
                sr += c.R; sg += c.G; sb += c.B; n++;
                int cell = Math.Min(15, j * 16 / hh) * 16 + Math.Min(15, i * 16 / w);
                sig[cell] += (c.R * 3 + c.G * 6 + c.B) / 10; counts[cell]++;
            }
            var sigList = new ArrayList();
            for (int k = 0; k < 256; k++) sigList.Add(counts[k] > 0 ? sig[k] / counts[k] : 0);
            return new Dictionary<string, object> {
                { "r", (int)(sr / n) }, { "g", (int)(sg / n) }, { "b", (int)(sb / n) }, { "sig", sigList }, { "method", used } };
        }
    }

    // ---------- input ----------
    // Scancodes, not virtual keys: games that read raw input or DirectInput ignore VK-only events.
    static readonly Dictionary<string, int[]> Keys = BuildKeys();
    static Dictionary<string, int[]> BuildKeys()
    {
        var k = new Dictionary<string, int[]>(StringComparer.OrdinalIgnoreCase);
        string row1 = "QWERTYUIOP", row2 = "ASDFGHJKL", row3 = "ZXCVBNM";
        for (int i = 0; i < row1.Length; i++) k["Key" + row1[i]] = new[] { 0x10 + i, 0 };
        for (int i = 0; i < row2.Length; i++) k["Key" + row2[i]] = new[] { 0x1E + i, 0 };
        for (int i = 0; i < row3.Length; i++) k["Key" + row3[i]] = new[] { 0x2C + i, 0 };
        for (int i = 1; i <= 9; i++) k["Digit" + i] = new[] { 0x01 + i, 0 };
        k["Digit0"] = new[] { 0x0B, 0 };
        for (int i = 1; i <= 10; i++) k["F" + i] = new[] { 0x3A + i, 0 };
        k["F11"] = new[] { 0x57, 0 }; k["F12"] = new[] { 0x58, 0 };
        k["Escape"] = new[] { 0x01, 0 }; k["Tab"] = new[] { 0x0F, 0 }; k["Enter"] = new[] { 0x1C, 0 };
        k["Space"] = new[] { 0x39, 0 }; k["Backspace"] = new[] { 0x0E, 0 };
        k["ShiftLeft"] = new[] { 0x2A, 0 }; k["ShiftRight"] = new[] { 0x36, 0 }; k["Shift"] = new[] { 0x2A, 0 };
        k["ControlLeft"] = new[] { 0x1D, 0 }; k["ControlRight"] = new[] { 0x1D, 1 }; k["Control"] = new[] { 0x1D, 0 };
        k["AltLeft"] = new[] { 0x38, 0 }; k["AltRight"] = new[] { 0x38, 1 }; k["Alt"] = new[] { 0x38, 0 };
        k["CapsLock"] = new[] { 0x3A, 0 }; k["Backquote"] = new[] { 0x29, 0 }; k["Minus"] = new[] { 0x0C, 0 };
        k["Equal"] = new[] { 0x0D, 0 }; k["BracketLeft"] = new[] { 0x1A, 0 }; k["BracketRight"] = new[] { 0x1B, 0 };
        k["Semicolon"] = new[] { 0x27, 0 }; k["Quote"] = new[] { 0x28, 0 }; k["Comma"] = new[] { 0x33, 0 };
        k["Period"] = new[] { 0x34, 0 }; k["Slash"] = new[] { 0x35, 0 }; k["Backslash"] = new[] { 0x2B, 0 };
        k["ArrowUp"] = new[] { 0x48, 1 }; k["ArrowDown"] = new[] { 0x50, 1 }; k["ArrowLeft"] = new[] { 0x4B, 1 }; k["ArrowRight"] = new[] { 0x4D, 1 };
        k["Insert"] = new[] { 0x52, 1 }; k["Delete"] = new[] { 0x53, 1 }; k["Home"] = new[] { 0x47, 1 }; k["End"] = new[] { 0x4F, 1 };
        k["PageUp"] = new[] { 0x49, 1 }; k["PageDown"] = new[] { 0x51, 1 };
        return k;
    }

    static void Send(Native.INPUT i) { Native.SendInput(1, new[] { i }, Marshal.SizeOf(typeof(Native.INPUT))); }

    static void Key(string name, bool down)
    {
        if (name.Length == 1) name = char.IsDigit(name[0]) ? "Digit" + name : "Key" + char.ToUpperInvariant(name[0]);
        if (name == " ") name = "Space";
        int[] sc;
        if (!Keys.TryGetValue(name, out sc)) throw new Exception("unknown key " + name + " (use names like KeyW, Space, ArrowUp, ShiftLeft)");
        var i = new Native.INPUT { type = 1 };
        i.u.ki.wScan = (ushort)sc[0];
        i.u.ki.wVk = (ushort)Native.MapVirtualKey((uint)sc[0], 1 /*MAPVK_VSC_TO_VK*/);
        i.u.ki.dwFlags = 0x0008u /*SCANCODE*/ | (sc[1] == 1 ? 0x0001u /*EXTENDED*/ : 0) | (down ? 0 : 0x0002u /*KEYUP*/);
        Send(i);
    }

    static void Mouse(Dictionary<string, object> r)
    {
        string a = S(r, "action", "move");
        var i = new Native.INPUT { type = 0 };
        if (a == "move")
        {
            var p = new Native.POINT { X = I(r, "x", 0), Y = I(r, "y", 0) };
            Native.ClientToScreen(H(r), ref p);
            Native.SetCursorPos(p.X, p.Y);
            return;
        }
        if (a == "moveRel") { i.u.mi.dx = I(r, "dx", 0); i.u.mi.dy = I(r, "dy", 0); i.u.mi.dwFlags = 0x0001; Send(i); return; }
        if (a == "wheel") { i.u.mi.mouseData = unchecked((uint)(I(r, "dy", 0) * -1)); i.u.mi.dwFlags = 0x0800; Send(i); return; }
        string b = S(r, "button", "left");
        bool down = a == "down";
        uint f = b == "right" ? (down ? 0x0008u : 0x0010u) : b == "middle" ? (down ? 0x0020u : 0x0040u) : (down ? 0x0002u : 0x0004u);
        i.u.mi.dwFlags = f;
        Send(i);
    }

    // ---------- filmstrip ----------
    static string Sheet(Dictionary<string, object> r)
    {
        var tiles = (object[])r["tiles"];
        var labels = r.ContainsKey("labels") ? (object[])r["labels"] : new object[0];
        int cols = I(r, "cols", 4);
        double scale = D(r, "scale", 0.3);
        var imgs = new List<Image>();
        foreach (var t in tiles) imgs.Add(Image.FromStream(new MemoryStream(Convert.FromBase64String((string)t))));
        int w = (int)(imgs[0].Width * scale), h = (int)(imgs[0].Height * scale);
        int rows = (imgs.Count + cols - 1) / cols;
        using (var sheet = new Bitmap(w * cols, h * rows, PixelFormat.Format24bppRgb))
        using (var g = Graphics.FromImage(sheet))
        using (var font = new Font("Consolas", 10f))
        {
            g.Clear(Color.Black);
            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
            for (int i = 0; i < imgs.Count; i++)
            {
                int x = (i % cols) * w, y = (i / cols) * h;
                g.DrawImage(imgs[i], x, y, w, h);
                string label = i < labels.Length ? Convert.ToString(labels[i]) : "";
                if (label.Length > 0)
                {
                    using (var bg = new SolidBrush(Color.FromArgb(170, 0, 0, 0))) g.FillRectangle(bg, x, y, 8 + label.Length * 8, 18);
                    g.DrawString(label, font, Brushes.White, x + 4, y + 2);
                }
                g.DrawRectangle(Pens.Black, x, y, w - 1, h - 1);
                imgs[i].Dispose();
            }
            var enc = Array.Find(ImageCodecInfo.GetImageEncoders(), delegate (ImageCodecInfo c) { return c.MimeType == "image/jpeg"; });
            var ps = new EncoderParameters(1);
            ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 78L);
            using (var ms = new MemoryStream()) { sheet.Save(ms, enc, ps); return Convert.ToBase64String(ms.ToArray()); }
        }
    }

    // ---------- freeze ----------
    static bool SuspendResume(int pid, bool suspend)
    {
        IntPtr h = Native.OpenProcess(0x0800 /*PROCESS_SUSPEND_RESUME*/, false, pid);
        if (h == IntPtr.Zero) return false;
        int st = suspend ? Native.NtSuspendProcess(h) : Native.NtResumeProcess(h);
        Native.CloseHandle(h);
        if (st == 0) { if (suspend) Frozen.Add(pid); else Frozen.Remove(pid); }
        return st == 0;
    }
}
