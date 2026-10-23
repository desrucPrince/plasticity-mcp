# Plasticity MCP speed work

Measured 2026-10-23 on macOS 27.0.1 (Apple Silicon) with Plasticity 26.1.3. Raw data:
`perf-baseline.json` (before) and `perf-after.json` (after). The benchmark is `bench.ts`.

## Finding

Plasticity itself was never the slow part. A status read takes 4–11 ms. Creating a box takes
40–90 ms, of which the CAD operation is 15–30 ms. The time went into model round trips and the
size of each response, which the model must read:

- One catalog lookup for "box" returned **272 KB**. The query matched long strength-tool
  descriptions and sent every JSON schema.
- In compact mode, each modeling operation needed a catalog lookup first.
- Each edit needed a revision, so agents called `plasticity_status` before every edit.
- A session had to call `plasticity_list_windows` and then `plasticity_connect` before it could work.
- A screenshot was saved to a file, and the agent needed one more turn to look at it.

## Before and after

| Measure | Before | After |
|---|---|---|
| Model turns for "box with a through hole and filleted edges" | about 11 | **1** (`plasticity_batch`) |
| Time for that build (1 body / 20 bodies in the document) | 11 turns of model time | **227 / 352 ms** in one call |
| Catalog lookup "box" | 272,045 bytes | **1,899 bytes** |
| Catalog lookup for an exact tool name (with schema) | same as above | 1,189 bytes |
| `plasticity_status` response | 2,490 bytes | 1,450 bytes |
| Box edit response | 3,314 bytes | 2,276 bytes |
| Revision string that agents echo on every edit | 263 characters | about 20 characters |
| Turns before the first real call in a session | 2 (list windows, connect) | **0** with one window open |
| Seeing a screenshot | 2 turns (save, then read the file) | 1 turn (image in the response) |
| Compact `tools/list` | 11 tools, 7.6 KB | 29 tools, 24.7 KB |
| Full-mode `tools/list` (not used by the compact registration) | 955 KB | 956 KB, unchanged |
| Server start / connect | — | 0.4 s / 0.6 s |

Single-operation server times did not change in a way that matters. Status is 4–11 ms and a box
edit is 33–90 ms both before and after; the differences are run-to-run variance.

The compact tool list grew because 17 modeling tools are now listed directly. That costs about
4k tokens once per session and removes a catalog lookup before each operation.

## What changed (branch `discovery/command-catalog`)

1. **Catalog summaries.** A catalog query returns names and one-line summaries. Name matches come
   first. A schema comes back only for an exact tool name or `schema: true`.
2. **`plasticity_batch`.** Up to 50 steps in one call, under one lock, with one combined change.
   A step may omit `revision`. Later steps refer to earlier output: `"$0.added[0]"` for a created
   body, `"$3.result.matches[*].id"` for ids from a read step such as `plasticity_find_edges`.
   It stops at the first failing step, names that step, and can undo the completed steps
   (`undoOnError`). The tool lock is now reentrant so batch can call the other tools.
3. **Direct modeling tools in compact mode.** Box, cylinder, sphere, boolean, fillet, chamfer,
   extrude (faces, profile), move, rotate, scale, mirror, delete, undo, redo, find edges, find faces.
4. **Smaller responses.** Compact JSON instead of pretty-printed JSON. Short hashed revisions. The
   six standard construction planes are named by id instead of repeated in full.
5. **Auto-connect.** With exactly one Plasticity window open, the first tool call connects to it.
   With several windows, nothing is guessed. If auto-connect fails (for example, another MCP
   session owns the window), the tools report that reason.
6. **Inline screenshots.** `plasticity_screenshot` without `path` returns a JPEG (width 1024,
   quality 70) in the response.
7. **Server instructions** tell agents to batch, to skip status calls before edits, and to use the
   find tools instead of full body dumps.
8. **Measurement.** `PLASTICITY_TIMING=1` adds per-phase milliseconds to edit results. There are
   probes for startup, the tool list and the catalog.

## Not done, and why

- **`plasticity_eval` (run JavaScript in Plasticity).** The session's safety guard blocked it as a
  remote-code-execution surface. If you want it, add it yourself or allow it explicitly.
- **Optional `revision` on direct calls.** Existing tests protect the rule that a direct edit names
  the revision it is based on. Batch steps get the revision automatically, and every edit result
  returns the next revision, so agents do not need a status call.
- **State cache and cheap probe.** A full state read is 4–15 ms, so a cache would save almost nothing.
- **Persistent renderer helper.** The CAD call is 15–30 ms. Re-sending the script is not the cost.
- **Rounding floats in responses.** Tests require exact native values, so values stay at full precision.
- **Shorter descriptions in full mode.** Your registration uses compact mode, where the long
  strength-tool descriptions are not listed; full mode is unchanged.
- **Fewer body summaries in edit results.** Tests require 20 body summaries per edit result. Batch
  returns one result for many steps.

## Caveats

- The edit benchmarks ran in a separate isolated Plasticity. Its "Untitled" document turned out to be
  a restored copy of an earlier unsaved session (bodies "smoke-box" and "cube-50"). Every test edit
  was undone, those bodies were never edited, and nothing was saved. After this was found, only
  read-only measurements were taken.
- The inline screenshot path is unit-tested. It was not checked live, because the Plasticity window
  was hidden at the time.
- One unrelated test failed once during the work and then passed on 3 reruns.
- The workbench package does not read Plasticity revisions or construction planes. Its typecheck
  passes, and its server (90) and web (23) tests pass after these changes.
- Restart or reconnect the MCP server in Claude Code (`/mcp`) to load these changes.
