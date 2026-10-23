# Plasticity MCP

![Plasticity MCP local CAD workflow](docs/assets/workflow.svg)

Control Plasticity from an MCP client: inspect and measure native CAD geometry, create and edit models, and export the result. An optional Workbench supports model review, dimensional feedback, and print preparation.

**Runs locally on macOS Apple Silicon with Plasticity 26.1.3.** The MCP server connects to a Plasticity window selected by the user; it cannot run as a standalone cloud CAD service.

| CAD workflow | What the server provides |
| --- | --- |
| Inspect | Scene state, precise B-rep measurements, and references to bodies, faces, and edges |
| Model | Native creation and editing with document history, Undo, and Redo |
| Deliver | Document operations, import/export, and camera screenshots |
| Review | Optional local Workbench with measurement tables, dimensional feedback, and tablet annotations |

The server uses Plasticity's own command factories and document history through a loopback-only Electron CDP endpoint. It does not patch or re-sign the application. MCP geometry inputs use millimeters and degrees; native edits support Plasticity Undo and Redo.

## What it provides

- Native Plasticity scene inspection, precise B-rep measurements, and revision-bound references to bodies, faces, and edges.
- Native CAD creation and editing, document operations, import/export, and camera screenshots.
- Agent guidance and workflows for image/sketch-driven design, functional clarification, fasteners, and practical strength screening.
- Optional Workbench for viewing models and measurement tables, submitting validated dimensional feedback, and tablet annotations on the same local network.
- Optional Creality Print workflow for slicing and print-job preparation. The agent waits for explicit user confirmation before starting a print.

See the [full tool reference](docs/tool-reference.md), [acceptance matrix](docs/acceptance-matrix.md), and [Workbench operations guide](docs/workbench-operations.md) for details and current verification status.

## Requirements

- macOS on Apple Silicon
- Plasticity 26.1.3 installed at `/Applications/Plasticity.app`
- Node.js 24 or newer
- Codex CLI for the Git-backed plugin installation below

This is an early, version-specific project. Live CAD and slicer operations depend on the installed applications and are not covered by mock tests alone. Check the [acceptance matrix](docs/acceptance-matrix.md) before relying on a specific operation.

## Install and run

```sh
git clone https://github.com/Mesteriis/plasticity-mcp.git
cd plasticity-mcp
npm install
npm run start:plasticity
npm run setup:codex
```

`setup:codex` adds this GitHub repository as a Codex plugin marketplace and installs the `plasticity-mcp` plugin from Git. It records this checkout's path in a private file under `~/.plasticity-mcp` so the two MCP servers can run the checked-out code and its installed dependencies. No machine-specific paths are committed. Open a new Codex chat after installation.

To use the MCP server without the plugin, register it directly instead:

```sh
codex mcp add plasticity -- npm --prefix "$PWD" start
```

Ask the agent to call `plasticity_list_windows`, then connect to an explicitly selected window with `plasticity_connect`.

The default MCP catalog shows the core connect, inspection, change-tracking, and screenshot tools plus `plasticity_call`. For any other operation, use `plasticity_call` with `toolName: "catalog"` and a search query to get its name and input schema, then call it through the same dispatcher. The full catalog remains available with `npm run start:full`; existing handlers and validation are the same in both modes.

The launcher does not terminate an existing Plasticity process to add MCP access. If it reports that a restart is needed, save your documents, close Plasticity yourself, then rerun the command. CDP listens on loopback only.

### Optional Workbench

The Workbench is not required for chat-based use. Start it on the local machine with:

```sh
npm run start:workbench
```

In another terminal on the same Mac, run `npm --workspace workbench run open:owner` to open an authenticated owner session. The server address alone does not grant owner access.

To make it reachable by a tablet on the same private network, run `npm run start:workbench -- --lan`; the server prints its local address. Do not expose it to the public internet. Follow the [Workbench guide](docs/workbench-operations.md) for registration, sharing, backup, and recovery.

## Using with Claude Code

1. Register the server once, at user scope, so it is available from every folder. Use an absolute
   path to a Node 24+ binary if your default `node` is older:

   ```sh
   claude mcp add plasticity --scope user \
     -e PLASTICITY_STRENGTH_ASSET_ROOT="$HOME/Projects/plasticity-mcp" \
     -- "$HOME/.nvm/versions/node/v24.21.0/bin/node" \
     "$HOME/Projects/plasticity-mcp/scripts/run-server.ts" --compact-tools
   ```

   Check that it is connected with `claude mcp list`.

2. Plasticity must be started with loopback CDP. There are three ways:
   - If Plasticity is not running, `plasticity_list_windows` and `plasticity_connect` start it with
     CDP for you. Set `PLASTICITY_AUTO_LAUNCH=0` to turn this off. It also stays off when
     `PLASTICITY_CDP_URL` is set.
   - Open Plasticity with a launcher app instead of the normal icon. Build it once with
     `osacompile -o ~/Applications/"Plasticity MCP.app" scripts/plasticity-mcp-launcher.applescript`,
     then put it in the Dock.
   - Run `npm run start:plasticity`.

   If Plasticity was opened the normal way, it has no CDP. The server never quits or restarts it.
   It returns an error that asks you to save, quit, and reopen with the launcher.

3. In a session, call `plasticity_list_windows`, then call `plasticity_connect` with the returned
   `targetId`.

## Working fast

- **Batch builds.** `plasticity_batch` runs up to 50 operations in one call and returns one
  combined change. A step may leave out `revision`. A later step can use what an earlier step made:
  `"$0.added[0]"` is the first body that step 0 created, and `"$3.result.matches[*].id"` is every
  edge id that a `plasticity_find_edges` step returned. Set `undoOnError: true` to undo the
  completed steps if a step fails. Example (box with a through hole and filleted edges, one call):

  ```json
  {"steps": [
    {"toolName": "plasticity_create_box", "arguments": {"originMm": [0,0,0], "sizeMm": [20,10,5]}},
    {"toolName": "plasticity_create_cylinder", "arguments": {"centerMm": [10,5,-1], "radiusMm": 3, "heightMm": 7}},
    {"toolName": "plasticity_boolean", "arguments": {"targetIds": ["$0.added[0]"], "toolIds": "$1.added", "operation": "difference"}},
    {"toolName": "plasticity_find_edges", "arguments": {"query": {"bodyIds": ["$0.added[0]"], "line": true}}},
    {"toolName": "plasticity_fillet", "arguments": {"id": "$0.added[0]", "edgeIds": "$3.result.matches[*].id", "radiusMm": 1}}
  ]}
  ```

- **Common tools are listed directly** in compact mode: box, cylinder, sphere, boolean, fillet,
  chamfer, extrude, move, rotate, scale, mirror, delete, undo, redo, and find edges or faces.
- **The catalog is small.** A query returns names and one-line summaries. To get the input schema,
  query the exact tool name.
- **No connect step with one window.** When exactly one Plasticity window is open, the first tool
  call connects to it. `plasticity_connect` also accepts no `targetId` in that case. With several
  windows you still choose one.
- **Screenshots come back inline.** `plasticity_screenshot` with no `path` returns a scaled JPEG
  (default width 1024) in the same response. Pass `path` to save a full-size PNG instead.
- **No status call before each edit.** Every edit result has the new revision and the changed bodies.
- `PLASTICITY_TIMING=1` adds per-phase milliseconds to edit results. `discovery/bench.ts` is the
  live benchmark; see `discovery/PERF-SUMMARY.md`.

## Development

```sh
npm test
npm run typecheck
npm --prefix workbench test
npm --prefix workbench run typecheck
npm --prefix workbench run build
```

Live acceptance checks use a real Plasticity session and can mutate a document. Read the corresponding acceptance guide and explicitly select a disposable test document before running them; they are not part of the default test suite.

## Safety and scope

- Mutations are serialized and checked against the current document revision; stale references are rejected.
- After a timeout or lost connection during a mutation, inspect/reconcile the scene before issuing another change.
- Workbench dimensional inputs are validated in the browser and again on the server.
- Print submission and starting a print are separate actions; starting requires explicit user confirmation.
- This project does not replace Plasticity, provide certified engineering analysis, or guarantee printability or part strength. Strength tools are screening calculations whose assumptions and limitations must be reviewed.

## Contributing and support

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report security issues using the private reporting process in [SECURITY.md](SECURITY.md). See [SUPPORT.md](SUPPORT.md) for bug reports, feature requests, and usage questions. Contributions are released under the [MIT License](LICENSE), with copyright attributed to Aleksand Meshchriakov.
