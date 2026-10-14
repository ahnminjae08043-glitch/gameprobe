// Builds the gameprobe test scene and a Windows player from the command line:
//   Unity.exe -batchmode -quit -projectPath TestGame -executeMethod BuildTestGame.Build
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;

public static class BuildTestGame
{
    static Material Mat(string name, Color c)
    {
        Directory.CreateDirectory("Assets/Materials");
        var path = "Assets/Materials/" + name + ".mat";
        var m = AssetDatabase.LoadAssetAtPath<Material>(path);
        if (m == null) { m = new Material(Shader.Find("Standard")); AssetDatabase.CreateAsset(m, path); }
        m.color = c;
        EditorUtility.SetDirty(m);
        return m;
    }

    static GameObject Box(string name, Vector3 pos, Vector3 size, Material m)
    {
        var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
        go.name = name; go.transform.position = pos; go.transform.localScale = size;
        go.GetComponent<Renderer>().sharedMaterial = m;
        return go;
    }

    static void Coin(string name, Vector3 pos, Material m)
    {
        var go = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
        go.name = name; go.transform.position = pos;
        go.transform.localScale = new Vector3(0.7f, 0.06f, 0.7f);
        go.transform.rotation = Quaternion.Euler(90, 0, 0);
        Object.DestroyImmediate(go.GetComponent<Collider>());
        var trigger = go.AddComponent<SphereCollider>();
        trigger.isTrigger = true; trigger.radius = 0.6f;
        go.GetComponent<Renderer>().sharedMaterial = m;
        go.AddComponent<Coin>();
    }

    public static void MakeScene()
    {
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        RenderSettings.ambientMode = AmbientMode.Flat;
        RenderSettings.ambientLight = new Color(0.45f, 0.47f, 0.52f);

        var light = new GameObject("Sun").AddComponent<Light>();
        light.type = LightType.Directional; light.intensity = 1.1f; light.shadows = LightShadows.Soft;
        light.transform.rotation = Quaternion.Euler(50, -30, 0);

        var gray = Mat("Ground", new Color(0.33f, 0.36f, 0.4f));
        var plat = Mat("Platform", new Color(0.35f, 0.5f, 0.75f));
        var gold = Mat("Coin", new Color(1f, 0.8f, 0.2f));
        var orange = Mat("Player", new Color(0.95f, 0.5f, 0.2f));

        Box("Ground", new Vector3(0, -0.5f, 10), new Vector3(30, 1, 40), gray);
        Box("PlatformA", new Vector3(0, 0.5f, 14), new Vector3(4, 1, 4), plat);
        Box("PlatformB", new Vector3(6, 0.75f, 19), new Vector3(4, 1.5f, 4), plat);

        // three coins on the ground, two above the platforms at chest height
        Coin("CoinLow1", new Vector3(0, 0.5f, 4), gold);
        Coin("CoinLow2", new Vector3(3, 0.5f, 8), gold);
        Coin("CoinLow3", new Vector3(-3, 0.5f, 8), gold);
        Coin("CoinHighA", new Vector3(0, 2.5f, 14), gold);
        Coin("CoinHighB", new Vector3(6, 3.0f, 19), gold);

        var player = GameObject.CreatePrimitive(PrimitiveType.Capsule);
        player.name = "Player"; player.transform.position = new Vector3(0, 1, 0);
        player.GetComponent<Renderer>().sharedMaterial = orange;
        var rb = player.AddComponent<Rigidbody>(); rb.mass = 1;
        player.AddComponent<PlayerController>();

        // A "ground check" collider someone added at the feet. It has the exact shape of the capsule's bottom,
        // so anything the bottom of the player touches is touched by two colliders at once.
        var feet = new GameObject("Feet");
        feet.transform.SetParent(player.transform, false);
        feet.transform.localPosition = new Vector3(0, -0.5f, 0);
        feet.AddComponent<SphereCollider>().radius = 0.5f;

        var cam = new GameObject("Main Camera");
        cam.tag = "MainCamera";
        cam.AddComponent<Camera>().fieldOfView = 60;
        cam.transform.SetParent(player.transform, false);
        cam.transform.localPosition = new Vector3(0, 2.2f, -5.5f);
        cam.transform.localRotation = Quaternion.Euler(15, 0, 0);

        new GameObject("GameManager").AddComponent<GameManager>();

        Directory.CreateDirectory("Assets/Scenes");
        EditorSceneManager.SaveScene(scene, "Assets/Scenes/Main.unity");
        AssetDatabase.SaveAssets();
    }

    public static void Build()
    {
        MakeScene();
        PlayerSettings.productName = "gameprobe TestGame";
        PlayerSettings.fullScreenMode = FullScreenMode.Windowed;
        PlayerSettings.defaultScreenWidth = 1280;
        PlayerSettings.defaultScreenHeight = 720;
        PlayerSettings.resizableWindow = false;
        PlayerSettings.runInBackground = true;
        PlayerSettings.SplashScreen.show = false;
        // GP_GFX=d3d11 / d3d12 / vulkan forces a graphics API so capture can be tested per API
        var gfx = System.Environment.GetEnvironmentVariable("GP_GFX");
        if (!string.IsNullOrEmpty(gfx))
        {
            var api = gfx == "d3d11" ? GraphicsDeviceType.Direct3D11 : gfx == "vulkan" ? GraphicsDeviceType.Vulkan : GraphicsDeviceType.Direct3D12;
            PlayerSettings.SetUseDefaultGraphicsAPIs(BuildTarget.StandaloneWindows64, false);
            PlayerSettings.SetGraphicsAPIs(BuildTarget.StandaloneWindows64, new[] { api });
        }
        else PlayerSettings.SetUseDefaultGraphicsAPIs(BuildTarget.StandaloneWindows64, true);
        var opts = new BuildPlayerOptions
        {
            scenes = new[] { "Assets/Scenes/Main.unity" },
            locationPathName = (System.Environment.GetEnvironmentVariable("GP_OUT") ?? "Build") + "/TestGame.exe",
            target = BuildTarget.StandaloneWindows64,
            options = BuildOptions.None,
        };
        var report = BuildPipeline.BuildPlayer(opts);
        Debug.Log("[build] result " + report.summary.result + " errors " + report.summary.totalErrors);
        if (report.summary.result != UnityEditor.Build.Reporting.BuildResult.Succeeded) EditorApplication.Exit(1);
    }
}
