// Path language for reading and writing game state from the agent.
//
//   Player.transform.position.y        GameObject named Player, then members
//   Player.PlayerController.score      a component by type name, then its fields/properties (private too)
//   [Main Camera].transform.position   names with spaces or dots go in brackets
//   #GameManager.coins                 the first active object of a component type
//   GameManager.Instance.coins         static member of a type
//   Player.Inventory.items[0].name     list / array indexing
//   $frame $time $scene $fps           specials
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace GameProbe
{
    public static class Paths
    {
        const BindingFlags Inst = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.FlattenHierarchy;
        const BindingFlags Stat = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.FlattenHierarchy;

        static Dictionary<string, Type> typeCache;

        public static Type FindType(string name)
        {
            if (typeCache == null)
            {
                typeCache = new Dictionary<string, Type>(StringComparer.Ordinal);
                foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                {
                    Type[] types;
                    try { types = asm.GetTypes(); } catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t != null).ToArray(); }
                    foreach (var t in types)
                    {
                        // project types win over engine/library types with the same short name
                        bool user = asm.GetName().Name.StartsWith("Assembly-CSharp");
                        if (!typeCache.ContainsKey(t.Name) || user) typeCache[t.Name] = t;
                    }
                }
            }
            typeCache.TryGetValue(name, out var found);
            return found;
        }

        // "a.b[2].c" -> ["a", "b", "[2]", "c"], keeping [bracketed names] whole
        public static List<string> Split(string path)
        {
            var parts = new List<string>();
            int i = 0;
            while (i < path.Length)
            {
                char c = path[i];
                if (c == '.') { i++; continue; }
                if (c == '[')
                {
                    int j = path.IndexOf(']', i);
                    if (j < 0) throw new Exception("unclosed [ in path");
                    parts.Add(path.Substring(i, j - i + 1));
                    i = j + 1;
                    continue;
                }
                int k = i;
                while (k < path.Length && path[k] != '.' && path[k] != '[') k++;
                parts.Add(path.Substring(i, k - i));
                i = k;
            }
            return parts;
        }

        static bool IsIndex(string seg, out int idx)
        {
            idx = 0;
            return seg.StartsWith("[") && int.TryParse(seg.Substring(1, seg.Length - 2), NumberStyles.Integer, CultureInfo.InvariantCulture, out idx);
        }

        public static GameObject FindObject(string name)
        {
            var go = GameObject.Find(name);
            if (go) return go;
            foreach (var t in UnityEngine.Object.FindObjectsByType<Transform>(FindObjectsInactive.Include, FindObjectsSortMode.InstanceID))
                if (t.name == name) return t.gameObject;
            return null;
        }

        // Resolve everything but the last segment, so callers can read, write or call the last one.
        public static object Root(List<string> parts, out int next)
        {
            string first = parts[0];
            next = 1;
            if (first.StartsWith("$"))
            {
                switch (first)
                {
                    case "$frame": return Time.frameCount;
                    case "$time": return Time.time;
                    case "$dt": return Time.deltaTime;
                    case "$scene": return SceneManager.GetActiveScene().name;
                    case "$fps": return Time.deltaTime > 0 ? 1f / Time.deltaTime : 0f;
                    case "$timeScale": return Time.timeScale;
                }
                throw new Exception("unknown special " + first);
            }
            if (first.StartsWith("#"))
            {
                var t = FindType(first.Substring(1));
                if (t == null) throw new Exception("no type named " + first.Substring(1));
                var o = UnityEngine.Object.FindAnyObjectByType(t, FindObjectsInactive.Exclude);
                if (!o) throw new Exception("no active object of type " + t.Name);
                return o;
            }
            string name = first.StartsWith("[") ? first.Substring(1, first.Length - 2) : first;
            var go = FindObject(name);
            var type = FindType(name);
            // A GameObject and a type often share a name (a "GameManager" object holding a GameManager).
            // Prefer the object unless the next segment only makes sense as a static member of the type.
            if (go && type != null && parts.Count > 1 && !first.StartsWith("["))
            {
                bool onObject = FindComponent(go, parts[1]) != null || Member(typeof(GameObject), parts[1]) != null;
                bool staticOnType = type.GetProperty(parts[1], Stat) != null || type.GetField(parts[1], Stat) != null;
                if (!onObject && staticOnType) { next = 2; return GetMember(null, type, parts[1]); }
            }
            if (go) return go;
            if (type != null)
            {
                if (parts.Count < 2) return type;
                next = 2;
                return GetMember(null, type, parts[1]);
            }
            throw new Exception("nothing named '" + name + "': not a GameObject in the scene, not a type. Use game_eval $tree() to list objects");
        }

        public static object Get(string path)
        {
            var parts = Split(path);
            var cur = Root(parts, out int i);
            for (; i < parts.Count; i++) cur = Step(cur, parts[i]);
            return cur;
        }

        // Reading renderer.material / meshFilter.mesh makes Unity clone the asset, which changes the game.
        // Read the shared asset instead.
        static readonly Dictionary<string, string> SharedInstead = new Dictionary<string, string> {
            { "material", "sharedMaterial" }, { "materials", "sharedMaterials" }, { "mesh", "sharedMesh" } };

        static object Step(object cur, string seg)
        {
            if (cur == null) throw new Exception("null before ." + seg);
            if ((cur is Renderer || cur is MeshFilter || cur is Collider) && SharedInstead.TryGetValue(seg, out var shared)) seg = shared;
            if (IsIndex(seg, out int idx))
            {
                if (cur is IList list) return list[idx];
                throw new Exception("cannot index " + cur.GetType().Name);
            }
            if (cur is GameObject go)
            {
                // a component type wins, then GameObject members (transform, activeSelf, name, tag, layer)
                var comp = FindComponent(go, seg);
                if (comp) return comp;
            }
            if (cur is Component c && !(cur is Transform) && seg != "transform" && seg != "gameObject" && Member(cur.GetType(), seg) == null)
            {
                var other = FindComponent(c.gameObject, seg);
                if (other) return other;
            }
            return GetMember(cur, cur.GetType(), seg);
        }

        static Component FindComponent(GameObject go, string typeName)
        {
            foreach (var c in go.GetComponents<Component>())
                if (c && (c.GetType().Name == typeName || string.Equals(c.GetType().Name, typeName, StringComparison.OrdinalIgnoreCase))) return c;
            return null;
        }

        static MemberInfo Member(Type t, string name)
        {
            var bf = Inst | BindingFlags.Static;
            MemberInfo m = t.GetProperty(name, bf);
            if (m == null) m = t.GetField(name, bf);
            if (m == null) m = t.GetProperty(name, bf | BindingFlags.IgnoreCase);
            if (m == null) m = t.GetField(name, bf | BindingFlags.IgnoreCase);
            // Unity-serialized private fields are often written as m_Name or _name
            if (m == null) m = t.GetField("_" + name, bf | BindingFlags.IgnoreCase);
            if (m == null) m = t.GetField("m_" + name, bf | BindingFlags.IgnoreCase);
            return m;
        }

        static object GetMember(object target, Type t, string name)
        {
            var m = Member(t, name);
            if (m is PropertyInfo p) return p.GetValue(target);
            if (m is FieldInfo f) return f.GetValue(target);
            var meth = t.GetMethod(name, (target == null ? Stat : Inst), null, Type.EmptyTypes, null);
            if (meth != null) return meth.Invoke(target, null);
            throw new Exception(t.Name + " has no member '" + name + "'. Members: " + string.Join(", ", MemberNames(t).Take(30)));
        }

        public static IEnumerable<string> MemberNames(Type t)
        {
            foreach (var f in t.GetFields(Inst)) if (!f.Name.Contains("<")) yield return f.Name;
            foreach (var p in t.GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)) yield return p.Name;
        }

        public static void Set(string path, object value)
        {
            var parts = Split(path);
            if (parts.Count < 2) throw new Exception("cannot assign to a root");
            var cur = Root(parts, out int i);
            for (; i < parts.Count - 1; i++) cur = Step(cur, parts[i]);
            string last = parts[parts.Count - 1];
            if (IsIndex(last, out int idx)) { var list = (IList)cur; list[idx] = Convert(value, list.GetType().GetElementType() ?? typeof(object)); return; }
            var m = Member(cur.GetType(), last);
            if (m is PropertyInfo p) p.SetValue(cur, Convert(value, p.PropertyType));
            else if (m is FieldInfo f) f.SetValue(cur, Convert(value, f.FieldType));
            else throw new Exception(cur.GetType().Name + " has no member '" + last + "'");
            // struct members (position.y) do not write back through a copy: assign the parent struct again
            if (parts.Count >= 3 && cur.GetType().IsValueType)
            {
                var parentPath = string.Join(".", parts.Take(parts.Count - 1));
                SetRaw(parentPath, cur);
            }
        }

        static void SetRaw(string path, object value)
        {
            var parts = Split(path);
            var cur = Root(parts, out int i);
            for (; i < parts.Count - 1; i++) cur = Step(cur, parts[i]);
            var m = Member(cur.GetType(), parts[parts.Count - 1]);
            if (m is PropertyInfo p && p.CanWrite) p.SetValue(cur, value);
            else if (m is FieldInfo f) f.SetValue(cur, value);
        }

        public static object Call(string path, List<object> args)
        {
            var parts = Split(path);
            object target;
            string methodName = parts[parts.Count - 1];
            if (parts.Count == 1) throw new Exception("give Object.Method");
            var cur = Root(parts.Take(parts.Count - 1).ToList(), out int i);
            for (; i < parts.Count - 1; i++) cur = Step(cur, parts[i]);
            target = cur;
            Type t = target as Type ?? target.GetType();
            object inst = target is Type ? null : target;
            var cands = t.GetMethods((inst == null ? Stat : Inst)).Where(m => m.Name == methodName && m.GetParameters().Length == args.Count).ToList();
            if (cands.Count == 0) throw new Exception(t.Name + " has no method " + methodName + " taking " + args.Count + " args");
            var meth = cands[0];
            var ps = meth.GetParameters();
            var conv = new object[args.Count];
            for (int k = 0; k < args.Count; k++) conv[k] = Convert(args[k], ps[k].ParameterType);
            return meth.Invoke(inst, conv);
        }

        public static object Convert(object v, Type t)
        {
            if (v == null) return null;
            if (t == typeof(object)) return v;
            if (t.IsInstanceOfType(v)) return v;
            if (t.IsEnum) return v is string s ? Enum.Parse(t, s, true) : Enum.ToObject(t, System.Convert.ToInt32(v));
            if (t == typeof(Vector3)) { var a = Floats(v, 3); return new Vector3(a[0], a[1], a[2]); }
            if (t == typeof(Vector2)) { var a = Floats(v, 2); return new Vector2(a[0], a[1]); }
            if (t == typeof(Vector4)) { var a = Floats(v, 4); return new Vector4(a[0], a[1], a[2], a[3]); }
            if (t == typeof(Quaternion)) { var a = Floats(v, 3); return Quaternion.Euler(a[0], a[1], a[2]); }
            if (t == typeof(Color)) { var a = Floats(v, 4); return new Color(a[0], a[1], a[2], a[3]); }
            return System.Convert.ChangeType(v, t, CultureInfo.InvariantCulture);
        }

        static float[] Floats(object v, int n)
        {
            var r = new float[n];
            if (n == 4) r[3] = 1;
            if (v is IList l) for (int i = 0; i < Math.Min(n, l.Count); i++) r[i] = System.Convert.ToSingle(l[i], CultureInfo.InvariantCulture);
            else if (v is IDictionary d) { string[] k = { "x", "y", "z", "w" }; for (int i = 0; i < n; i++) if (d.Contains(k[i])) r[i] = System.Convert.ToSingle(d[k[i]], CultureInfo.InvariantCulture); }
            else throw new Exception("expected [x,y,z] or {x,y,z}");
            return r;
        }

        // Turn any value into something JSON-friendly and small.
        public static object Snapshot(object v, int depth = 2)
        {
            switch (v)
            {
                case null: return null;
                case string s: return s.Length > 300 ? s.Substring(0, 300) + "..." : s;
                case bool b: return b;
                case float f: return Round(f);
                case double d: return Round(d);
                case int or long or short or byte or uint: return System.Convert.ToDouble(v);
                case Enum e: return e.ToString();
                case Vector3 a: return new Dictionary<string, object> { { "x", Round(a.x) }, { "y", Round(a.y) }, { "z", Round(a.z) } };
                case Vector2 a: return new Dictionary<string, object> { { "x", Round(a.x) }, { "y", Round(a.y) } };
                case Vector3Int a: return new Dictionary<string, object> { { "x", a.x }, { "y", a.y }, { "z", a.z } };
                case Vector2Int a: return new Dictionary<string, object> { { "x", a.x }, { "y", a.y } };
                case Quaternion q: { var e = q.eulerAngles; return new Dictionary<string, object> { { "euler", Snapshot(e) } }; }
                case Color c: return new Dictionary<string, object> { { "r", Round(c.r) }, { "g", Round(c.g) }, { "b", Round(c.b) }, { "a", Round(c.a) } };
                case Type t: return "<type " + t.FullName + ">";
                case GameObject go:
                    if (!go) return "<destroyed>";
                    if (depth <= 0) return "<GameObject " + go.name + ">";
                {
                    var d = new Dictionary<string, object> { { "name", go.name }, { "active", go.activeInHierarchy }, { "position", Snapshot(go.transform.position) } };
                    var comps = new Dictionary<string, object>();
                    foreach (var c in go.GetComponents<Component>())
                    {
                        if (!c || c is Transform) continue;
                        var key = comps.ContainsKey(c.GetType().Name) ? c.GetType().Name + "#" + comps.Count : c.GetType().Name;
                        comps[key] = depth >= 2 ? Snapshot(c, 1) : "<" + c.GetType().Name + ">";
                    }
                    d["components"] = comps;
                    if (go.transform.childCount > 0) d["children"] = Enumerable.Range(0, go.transform.childCount).Select(i => (object)go.transform.GetChild(i).name).ToList();
                    return d;
                }
                case UnityEngine.Object uo:
                    if (!uo) return "<destroyed>";
                    if (depth <= 0 || uo is Transform && depth < 2) return "<" + uo.GetType().Name + " " + uo.name + ">";
                    break;
            }
            if (v is IDictionary dict)
            {
                var o = new Dictionary<string, object>(); int n = 0;
                foreach (DictionaryEntry kv in dict) { if (++n > 40) break; o[kv.Key.ToString()] = depth > 0 ? Snapshot(kv.Value, depth - 1) : "..."; }
                return o;
            }
            if (v is IEnumerable en)
            {
                var l = new List<object>(); int n = 0;
                foreach (var x in en) { if (++n > 40) { l.Add("..."); break; } l.Add(depth > 0 ? Snapshot(x, depth - 1) : "..."); }
                return l;
            }
            if (depth <= 0) return "<" + v.GetType().Name + ">";
            var obj = new Dictionary<string, object>();
            var t2 = v.GetType();
            if (v is Transform tr)
            {
                obj["position"] = Snapshot(tr.position); obj["localPosition"] = Snapshot(tr.localPosition);
                obj["rotation"] = Snapshot(tr.rotation); obj["localScale"] = Snapshot(tr.localScale);
                return obj;
            }
            if (v is Component comp) obj["$type"] = t2.Name;
            int count = 0;
            foreach (var f in t2.GetFields(Inst))
            {
                if (f.Name.Contains("<") || f.DeclaringType == typeof(MonoBehaviour) || f.DeclaringType == typeof(Behaviour) || f.DeclaringType == typeof(Component) || f.DeclaringType == typeof(UnityEngine.Object)) continue;
                if (++count > 30) break;
                try { obj[f.Name] = Snapshot(f.GetValue(v), depth - 1); } catch { }
            }
            if (v is Rigidbody rb) { obj["linearVelocity"] = Snapshot(rb.linearVelocity); obj["angularVelocity"] = Snapshot(rb.angularVelocity); obj["isKinematic"] = rb.isKinematic; obj["mass"] = Round(rb.mass); }
            if (v is Rigidbody2D rb2) { obj["linearVelocity"] = Snapshot(rb2.linearVelocity); obj["angularVelocity"] = Round(rb2.angularVelocity); }
            if (v is CharacterController cc) { obj["isGrounded"] = cc.isGrounded; obj["velocity"] = Snapshot(cc.velocity); }
            if (v is Behaviour bh) obj["enabled"] = bh.enabled;
            // Engine components keep their state in native code: show their simple public properties instead
            if (v is Component && t2.Namespace != null && t2.Namespace.StartsWith("UnityEngine"))
            {
                foreach (var p in t2.GetProperties(BindingFlags.Instance | BindingFlags.Public))
                {
                    if (obj.Count > 30) break;
                    if (!p.CanRead || p.GetIndexParameters().Length > 0 || obj.ContainsKey(p.Name)) continue;
                    if (SharedInstead.ContainsKey(p.Name) || p.IsDefined(typeof(ObsoleteAttribute), true)) continue;
                    if (p.DeclaringType == typeof(Component) || p.DeclaringType == typeof(UnityEngine.Object) || p.DeclaringType == typeof(Behaviour)) continue;
                    var pt = p.PropertyType;
                    bool simple = pt.IsPrimitive || pt.IsEnum || pt == typeof(string) || pt == typeof(Vector3) || pt == typeof(Vector2) || pt == typeof(Color) || pt == typeof(Bounds) || typeof(UnityEngine.Object).IsAssignableFrom(pt);
                    if (!simple) continue;
                    try { var val = p.GetValue(v); obj[p.Name] = val is Bounds b ? new Dictionary<string, object> { { "center", Snapshot(b.center) }, { "size", Snapshot(b.size) } } : Snapshot(val, 0); } catch { }
                }
            }
            return obj;
        }

        static double Round(double d) => double.IsNaN(d) || double.IsInfinity(d) ? 0 : Math.Round(d, 4);

        public static List<object> Tree(int maxDepth, string rootName)
        {
            var roots = new List<Transform>();
            if (!string.IsNullOrEmpty(rootName)) { var go = FindObject(rootName); if (!go) throw new Exception("no object " + rootName); roots.Add(go.transform); }
            else for (int s = 0; s < SceneManager.sceneCount; s++) foreach (var r in SceneManager.GetSceneAt(s).GetRootGameObjects()) roots.Add(r.transform);
            var dd = GameObjectExtensionsDontDestroy();
            if (string.IsNullOrEmpty(rootName)) roots.AddRange(dd);
            int budget = 400;
            return roots.Select(r => Node(r, 0, maxDepth, ref budget)).Where(n => n != null).ToList();
        }

        static List<Transform> GameObjectExtensionsDontDestroy()
        {
            var list = new List<Transform>();
            foreach (var t in UnityEngine.Object.FindObjectsByType<Transform>(FindObjectsInactive.Include, FindObjectsSortMode.None))
                if (t.parent == null && t.gameObject.scene.name == "DontDestroyOnLoad" && t.name != "[gameprobe]") list.Add(t);
            return list;
        }

        static object Node(Transform t, int depth, int maxDepth, ref int budget)
        {
            if (budget-- <= 0) return null;
            var comps = t.GetComponents<Component>().Where(c => c && !(c is Transform)).Select(c => c.GetType().Name).ToList();
            var n = new Dictionary<string, object> { { "name", t.name } };
            if (comps.Count > 0) n["components"] = comps;
            if (!t.gameObject.activeInHierarchy) n["active"] = false;
            n["position"] = Snapshot(t.position);
            if (t.childCount > 0)
            {
                if (depth >= maxDepth) n["children"] = t.childCount + " more (raise depth or pass root)";
                else
                {
                    var kids = new List<object>();
                    for (int i = 0; i < t.childCount; i++) { var k = Node(t.GetChild(i), depth + 1, maxDepth, ref budget); if (k != null) kids.Add(k); }
                    n["children"] = kids;
                }
            }
            return n;
        }
    }
}
