# Plasticity 26.1.3 static discovery

Recovered 2026-10-22 from `/Applications/Plasticity.app` (Plasticity 26.1.3, Electron 26.6.9, arm64).

The app ships as an unpacked `Resources/app/` directory, not `app.asar`. The real code is
bytenode V8 bytecode (`.webpack/renderer/app_window.compiled/index.jsc`, 12 MB, and
`.webpack/main/index.compiled.jsc`, 2 MB). The `.js` files beside them are only bytenode loaders.

| File | What it is |
|------|-----------|
| `commands.json` / `commands.txt` | 619 namespaced ids (191 `command:*`, 128 `gizmo:*`, 86 `keyboard:*`, ...) from the bytecode string pools |
| `factories.txt` | 180 `*Factory` class names |
| `keybindings-candidates.json` | 119 default key → command pairs. Heuristic: string adjacency. Single-letter keys are missing and some pairs are wrong |
| `rea-analyze.json` | REA `analyze-javascript-application` on the two loaders. REA does not accept `.jsc`, so it found no IPC, windows or bindings |
| `extract-jsc-strings.py` | Rerun: `python3 -I extract-jsc-strings.py /Applications/Plasticity.app/Contents/Resources/app/.webpack .` |

The strings show which ids exist. They do not show arguments, or whether an id is a command
or only a keymap target. To get the runtime registry, start Plasticity with CDP and dump it live
(`npm run start:plasticity`, then `npm run probe:targets`).

## Live catalog (2026-10-23, Plasticity launched via `npm run start:plasticity`, CDP 127.0.0.1:9223)

| File | What it is |
|------|-----------|
| `probe-targets.txt` | One window target: "Untitled - Plasticity" |
| `live-catalog.json` | 4603 native renderer bindings, 370 MCP operations with JSON input schemas (112 read-only), operation availability |
| `live-command-classes.txt` | 236 `*Command` classes among the bindings |
| `live-factory-classes.txt` | 182 `*Factory` classes (142 also in `factories.txt`; 40 live-only) |
| `dump-live-catalog.ts` | Rerun: `node discovery/dump-live-catalog.ts` from the repo root (read-only; connects, pages capabilities and the catalog) |

Bindings are class/function names, not the `command:*` ids in `commands.txt`; none of those ids appear in the bindings.
