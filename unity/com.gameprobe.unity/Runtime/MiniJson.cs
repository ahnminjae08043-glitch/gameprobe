// Minimal JSON for the gameprobe wire protocol. Objects become Dictionary<string, object>,
// arrays List<object>, numbers double. JsonUtility cannot do dictionaries, hence this.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace GameProbe
{
    public static class MiniJson
    {
        public static object Parse(string s) { int i = 0; var v = Value(s, ref i); return v; }

        static void Ws(string s, ref int i) { while (i < s.Length && char.IsWhiteSpace(s[i])) i++; }

        static object Value(string s, ref int i)
        {
            Ws(s, ref i);
            if (i >= s.Length) throw new FormatException("unexpected end of json");
            char c = s[i];
            if (c == '{')
            {
                var d = new Dictionary<string, object>(); i++; Ws(s, ref i);
                if (s[i] == '}') { i++; return d; }
                while (true)
                {
                    Ws(s, ref i); var k = Str(s, ref i); Ws(s, ref i);
                    if (s[i] != ':') throw new FormatException("expected :"); i++;
                    d[k] = Value(s, ref i); Ws(s, ref i);
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == '}') { i++; return d; }
                    throw new FormatException("expected , or }");
                }
            }
            if (c == '[')
            {
                var l = new List<object>(); i++; Ws(s, ref i);
                if (s[i] == ']') { i++; return l; }
                while (true)
                {
                    l.Add(Value(s, ref i)); Ws(s, ref i);
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == ']') { i++; return l; }
                    throw new FormatException("expected , or ]");
                }
            }
            if (c == '"') return Str(s, ref i);
            if (s.Length - i >= 4 && string.CompareOrdinal(s, i, "true", 0, 4) == 0) { i += 4; return true; }
            if (s.Length - i >= 5 && string.CompareOrdinal(s, i, "false", 0, 5) == 0) { i += 5; return false; }
            if (s.Length - i >= 4 && string.CompareOrdinal(s, i, "null", 0, 4) == 0) { i += 4; return null; }
            int st = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            return double.Parse(s.Substring(st, i - st), CultureInfo.InvariantCulture);
        }

        static string Str(string s, ref int i)
        {
            if (s[i] != '"') throw new FormatException("expected string");
            i++;
            var sb = new StringBuilder();
            while (s[i] != '"')
            {
                char c = s[i++];
                if (c != '\\') { sb.Append(c); continue; }
                char e = s[i++];
                switch (e)
                {
                    case 'n': sb.Append('\n'); break;
                    case 't': sb.Append('\t'); break;
                    case 'r': sb.Append('\r'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'u': sb.Append((char)Convert.ToInt32(s.Substring(i, 4), 16)); i += 4; break;
                    default: sb.Append(e); break;
                }
            }
            i++;
            return sb.ToString();
        }

        public static string Serialize(object o) { var sb = new StringBuilder(); Write(sb, o); return sb.ToString(); }

        static void Write(StringBuilder sb, object o)
        {
            switch (o)
            {
                case null: sb.Append("null"); return;
                case string s: WriteStr(sb, s); return;
                case bool b: sb.Append(b ? "true" : "false"); return;
                case double d: WriteNum(sb, d); return;
                case float f: WriteNum(sb, f); return;
                case int n: sb.Append(n.ToString(CultureInfo.InvariantCulture)); return;
                case long n: sb.Append(n.ToString(CultureInfo.InvariantCulture)); return;
                case IDictionary dict:
                    sb.Append('{'); bool first = true;
                    foreach (DictionaryEntry kv in dict) { if (!first) sb.Append(','); first = false; WriteStr(sb, kv.Key.ToString()); sb.Append(':'); Write(sb, kv.Value); }
                    sb.Append('}'); return;
                case IEnumerable list:
                    sb.Append('['); bool f1 = true;
                    foreach (var x in list) { if (!f1) sb.Append(','); f1 = false; Write(sb, x); }
                    sb.Append(']'); return;
                default:
                    if (o is IConvertible) { WriteNum(sb, Convert.ToDouble(o, CultureInfo.InvariantCulture)); return; }
                    WriteStr(sb, o.ToString()); return;
            }
        }

        static void WriteNum(StringBuilder sb, double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) { WriteStr(sb, d.ToString(CultureInfo.InvariantCulture)); return; }
            sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
        }

        static void WriteStr(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4")); else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }
    }
}
