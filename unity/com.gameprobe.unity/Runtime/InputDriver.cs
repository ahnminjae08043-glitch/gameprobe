// Feeds keyboard and mouse state straight into the Input System, frame by frame.
// No OS input is involved, so the real mouse and keyboard stay with the user and the window does not
// need focus. The legacy Input Manager (UnityEngine.Input.GetKey) cannot be driven this way.
using System;
using System.Collections.Generic;
using UnityEngine;
#if GAMEPROBE_INPUTSYSTEM
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;
#endif

namespace GameProbe
{
    public static class InputDriver
    {
        public static readonly HashSet<string> Keys = new HashSet<string>();
        public static readonly HashSet<string> Buttons = new HashSet<string>();
        public static Vector2 Look;          // mouse movement applied every frame
        public static Vector2? Pointer;      // absolute mouse position (pixels, origin bottom-left like Unity)
        static Vector2 pos = new Vector2(Screen.width / 2f, Screen.height / 2f);
        static bool dirty = true;

#if GAMEPROBE_INPUTSYSTEM
        public const bool Available = true;

        public static void Init()
        {
            // Queued events would be dropped while the window is unfocused; the agent never focuses it.
            InputSystem.settings.backgroundBehavior = InputSettings.BackgroundBehavior.IgnoreFocus;
#if UNITY_EDITOR
            // in play mode, input reaches the game even when the Game view is not focused
            InputSystem.settings.editorInputBehaviorInPlayMode = InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView;
#endif
            if (Keyboard.current == null) InputSystem.AddDevice<Keyboard>();
            if (Mouse.current == null) InputSystem.AddDevice<Mouse>();
        }

        public static void Set(IEnumerable<string> keys, IEnumerable<string> buttons, Vector2? look, Vector2? pointer)
        {
            if (keys != null) { Keys.Clear(); foreach (var k in keys) { ToKey(k); Keys.Add(k); } }
            if (buttons != null) { Buttons.Clear(); foreach (var b in buttons) Buttons.Add(b); }
            if (look.HasValue) Look = look.Value;
            if (pointer.HasValue) pos = pointer.Value;
            dirty = true;
        }

        // Called at the very start of every stepped frame, before the Input System's own update.
        public static void BeginFrame()
        {
            var kb = Keyboard.current; var mouse = Mouse.current;
            if (kb != null && dirty)
            {
                var keys = new List<Key>();
                foreach (var k in Keys) keys.Add(ToKey(k));
                InputSystem.QueueStateEvent(kb, new KeyboardState(keys.ToArray()));
            }
            if (mouse != null && (dirty || Look != Vector2.zero))
            {
                pos += Look;
                var ms = new MouseState { position = pos, delta = Look };
                if (Buttons.Contains("left")) ms = ms.WithButton(MouseButton.Left);
                if (Buttons.Contains("right")) ms = ms.WithButton(MouseButton.Right);
                if (Buttons.Contains("middle")) ms = ms.WithButton(MouseButton.Middle);
                InputSystem.QueueStateEvent(mouse, ms);
            }
            dirty = false;
        }

        public static Key ToKey(string name)
        {
            switch (name)
            {
                case "ArrowUp": return Key.UpArrow;
                case "ArrowDown": return Key.DownArrow;
                case "ArrowLeft": return Key.LeftArrow;
                case "ArrowRight": return Key.RightArrow;
                case "ShiftLeft": case "Shift": return Key.LeftShift;
                case "ShiftRight": return Key.RightShift;
                case "ControlLeft": case "Control": return Key.LeftCtrl;
                case "ControlRight": return Key.RightCtrl;
                case "AltLeft": case "Alt": return Key.LeftAlt;
                case "AltRight": return Key.RightAlt;
                case "Backquote": return Key.Backquote;
                case "BracketLeft": return Key.LeftBracket;
                case "BracketRight": return Key.RightBracket;
            }
            string n = name;
            if (n.StartsWith("Key") && n.Length == 4) n = n.Substring(3);
            if (n.Length == 1 && char.IsLetter(n[0])) n = n.ToUpperInvariant();
            if (n.Length == 1 && char.IsDigit(n[0])) n = "Digit" + n;
            if (Enum.TryParse(n, true, out Key key)) return key;
            throw new Exception("unknown key '" + name + "' (use names like KeyW, Space, ArrowUp, ShiftLeft, Digit1, Enter, Escape)");
        }
#else
        public const bool Available = false;
        public static void Init() { }
        public static void Set(IEnumerable<string> keys, IEnumerable<string> buttons, Vector2? look, Vector2? pointer)
        {
            throw new Exception("this project does not use the Input System package; gameprobe can only inject input through it");
        }
        public static void BeginFrame() { }
#endif
    }
}
