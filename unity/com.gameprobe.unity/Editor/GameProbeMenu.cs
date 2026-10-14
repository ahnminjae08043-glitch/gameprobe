// Tools > gameprobe: turn the agent connection on for play mode.
// With it on, pressing Play starts the gameprobe server inside the game (paused after the first frame) and an
// agent attaches with game_open { unity: 47777 }. The editor stays usable while the agent thinks.
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GameProbe.EditorTools
{
    public static class GameProbeMenu
    {
        const string Enabled = "gameprobe.enabled", Port = "gameprobe.port";
        const string Item = "Tools/gameprobe/Enable in Play Mode";

        [MenuItem(Item)]
        static void Toggle()
        {
            bool on = !EditorPrefs.GetBool(Enabled, false);
            EditorPrefs.SetBool(Enabled, on);
            Debug.Log(on
                ? "[gameprobe] enabled: press Play, then attach with game_open { unity: " + EditorPrefs.GetInt(Port, 47777) + " }"
                : "[gameprobe] disabled");
        }

        [MenuItem(Item, true)]
        static bool ToggleValidate() { Menu.SetChecked(Item, EditorPrefs.GetBool(Enabled, false)); return true; }

        [MenuItem("Tools/gameprobe/Use Port 47777")] static void P1() => SetPort(47777);
        [MenuItem("Tools/gameprobe/Use Port 47778")] static void P2() => SetPort(47778);

        static void SetPort(int p) { EditorPrefs.SetInt(Port, p); Debug.Log("[gameprobe] port " + p); }

        // For scripts and CI:  Unity.exe -projectPath P -executeMethod GameProbe.EditorTools.GameProbeMenu.EnableAndPlay
        // Optional: -gameprobe-scene Assets/Scenes/Main.unity  -gameprobe-port 47777
        public static void EnableAndPlay()
        {
            EditorPrefs.SetBool(Enabled, true);
            var args = System.Environment.GetCommandLineArgs();
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == "-gameprobe-port" && int.TryParse(args[i + 1], out int p)) EditorPrefs.SetInt(Port, p);
                if (args[i] == "-gameprobe-scene") EditorSceneManager.OpenScene(args[i + 1]);
            }
            var scene = EditorSceneManager.GetActiveScene();
            if (string.IsNullOrEmpty(scene.path) && EditorBuildSettings.scenes.Length > 0)
                EditorSceneManager.OpenScene(EditorBuildSettings.scenes[0].path);
            EditorApplication.isPlaying = true;
        }
    }
}
