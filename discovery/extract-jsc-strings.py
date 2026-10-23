"""Static string recovery from Plasticity's bytenode .jsc bundles.

Usage: python3 -I extract.py <webpack_dir> <out_dir>
"""
import json, re, sys, collections, pathlib

webpack, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
BUNDLES = {
    "renderer": webpack / "renderer/app_window.compiled/index.jsc",
    "main": webpack / "main/index.compiled.jsc",
}

def strings(path, n=3):
    data = path.read_bytes()
    return [m.group().decode("latin1") for m in re.finditer(rb"[\x20-\x7e]{%d,}" % n, data)]

ID = re.compile(r"^[a-z][a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)+$")
NON_COMMAND_NS = {"http", "https", "data", "blob", "ws", "wss", "about", "chrome", "devtools", "node", "electron", "mailto", "javascript"}
KEY = re.compile(r"^(?:(?:ctrl|cmd|alt|shift|meta|option)-)*(?:ctrl|cmd|alt|shift|meta|option)-[a-z0-9,./;'\[\]\\`=+-]+$|^(?:(?:ctrl|cmd|alt|shift|meta)-)*(?:mouse[0-2]|numpad\d|space|tab|escape|enter|delete|backspace|up|down|left|right|wheel)$")
FACTORY = re.compile(r"^[A-Z][A-Za-z0-9]*Factory$")

all_ids = collections.defaultdict(set)
factories = set()
key_pairs = []
for name, path in BUNDLES.items():
    s = strings(path)
    for i, t in enumerate(s):
        if ID.match(t) and t.split(":")[0] not in NON_COMMAND_NS:
            all_ids[t].add(name)
        if FACTORY.match(t):
            factories.add(t)
        # Keymap literals compile to adjacent constant-pool entries: key string then command id.
        # Single-char keys are often internalized elsewhere, so this misses bindings like "z" -> x.
        if KEY.match(t):
            for j in range(i + 1, min(i + 4, len(s))):
                if ID.match(s[j]):
                    key_pairs.append({"key": t, "command": s[j], "bundle": name})
                    break
                if KEY.match(s[j]):
                    break

by_ns = collections.defaultdict(list)
for cid in sorted(all_ids):
    by_ns[cid.split(":")[0]].append(cid)

commands = {
    "source": "strings recovered from V8 bytecode (.jsc) constant pools; not a runtime registry",
    "plasticity_version": "26.1.3",
    "total_ids": len(all_ids),
    "command_namespace_count": len(by_ns.get("command", [])),
    "namespaces": {ns: {"count": len(v), "ids": v} for ns, v in sorted(by_ns.items(), key=lambda kv: -len(kv[1]))},
    "bundles": {cid: sorted(b) for cid, b in sorted(all_ids.items())},
}
(out / "commands.json").write_text(json.dumps(commands, indent=2))
(out / "commands.txt").write_text("\n".join(sorted(all_ids)) + "\n")
(out / "factories.txt").write_text("\n".join(sorted(factories)) + "\n")
(out / "keybindings-candidates.json").write_text(json.dumps({
    "source": "heuristic: key-chord string followed within 3 constant-pool entries by a namespaced id; expect gaps and some mispairs",
    "count": len(key_pairs),
    "pairs": key_pairs,
}, indent=2))
print(json.dumps({"ids": len(all_ids), "command:*": len(by_ns.get("command", [])),
                  "namespaces": len(by_ns), "factories": len(factories), "key_pairs": len(key_pairs)}))
