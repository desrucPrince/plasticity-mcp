# FINDINGS: driving dimensions and other viewport-pick commands (2026-11-16)

Scripts and raw JSON: `discovery/probes-2026-11-pick/`. Isolated instance 127.0.0.1:57291 only.

## Summary
- The driving distance dimension did not wait on a viewport picker. It reads the **selection click point**.
- Plasticity records this point when the user clicks a face to select it. The store is `editor.selection.hits` (a `SelectionHitsSession`).
- A programmatic selection (`selection.selected.add`) records no hit. So `DimensionDistanceCommand.execute()` rejects with "Operation has no effect".
- Fix: call `editor.selection.hits.record(face, pointMeters, normal)`, then run the real `DimensionDistanceCommand` binding.
- The command then sets `clickPoint`, `to`, `direction`, `refDistance` and `containsRefEntity` itself. It opens `DimensionDistanceSpaceDialog`.
- Set `dialog.params.distance` (metres) and call `dialog.finish()`. The command commits natively as one undo step.
- The old gap-4 failure had a cause. The probe drove the factory outside the command's own `execute()`, so `to`, `direction` and `refDistance` stayed 0.

## Verdicts
| approach | verdict | evidence (MCP read-back) |
|---|---|---|
| A: seed the command's input (selection hit), run the real command, finish its own dialog | WORKS | `prove-driving-distance.json` `p1_factory_30`: bounds x 1999.9999999999998 → 2029.9999999999998 (20 → 30 mm). Undo depth 1 → 2 → 1 after `plasticity_undo`; undo restores 20 mm. |
| B: synthetic CDP mouse input only | PARTIAL | `probe-synthetic-click.json`: one `Input.dispatchMouseEvent` click at the projected point records the hit (Face 9f670, (2.02, 0.005000025, 0.00249998) m, normal +x), but selects the **solid**. Undo depth 4 → 5 for the click alone. DDC then rejects ("Operation has no effect"). Typing values with CDP key events was not run. |
| C: hybrid (synthetic clicks for the selection, native dialog finish) | WORKS, 3 undo steps | `probe-synthetic-click-clicks2.json`: click 1 selects the solid (undo 5); click 2 selects face 9f670 (undo 6); DDC commits (undo 7). Bounds max x 2029.9999999999998 (30 mm). Three `plasticity_undo` steps return to depth 4 and 20 mm. |

## Proofs
1. **20 → 30 mm, one undo step** (`p1_factory_30`): size 30 mm, undo 1 → 2, undo back to 1 gives 20 mm.
   - Through the dialog's own text input (DOM key events): "27.5" gives max x 2027.4999999999998, undo 1 → 2. "31 mm" gives 2030.9999999999998, undo 1 → 2.
2. **Five in a row** (`p2_repeat_*`), all pass; each undo goes 1 → 2 → 1 and restores 20 mm:

   | target | max x (mm) |
   |---|---|
   | 30 | 2029.9999999999998 |
   | 25 | 2025 |
   | 42.5 | 2042.5 |
   | 12.25 | 2012.2499999999998 |
   | 37 | 2037 |
3. **Generalises** (`prove-general.json`; each undo goes 4 → 5 → 4 and restores):
   - Cylinder caps, height 10 → 16 mm.
   - Cylinder top cap alone, 10 → 14 mm. With one face, the command finds the reference face itself (`containsRefEntity:false`).
   - Box with one face (+x) selected, 20 → 33 mm.
   - Box y faces, 10 → 18 mm.
4. **Failure paths** (`prove-driving-distance.json`):
   - **No hit:** "Operation has no effect" in about 11 ms. No dialog, `active:null`, undo stays 1, size 20 mm.
   - **Never finishes:** distance set and preview updated, then no finish. After a 5 s timeout, `executor.cancelActiveCommand()` runs. Result: command "Cancelled", `active:null`, the space input is gone, undo stays 1, size 20 mm.
   - **Hit on an unselected face (top):** this is *not* refused. The command used that point and moved +x to 30 mm. A tool must validate the hit face itself.
5. **Window state:**
   - All approach A runs: `document.hasFocus()` false, `visibilityState` "visible". Approach A needs no focus. Occlusion was not measured.
   - Minimised and hidden: untested. CDP `Browser.getWindowForTarget` is missing in this Electron build (`prove-window-minimized.json`), and I used no OS automation.
   - Approach A uses no raycast, no pointer events, no camera and no rendering. It finds the dialog in the `editor.helpers.scene` object graph. It polls with `setTimeout`, which a hidden page may throttle (slower, but it should not break; untested).
   - Approaches B and C need the face framed on screen and a projection through the camera. The synthetic click set `document.hasFocus()` to true.

## Other observations
- `executor.isBusy` is **false** while a command is Awaiting its dialog. Guard on `executor.active` (`.command`) instead (seen in stdout).
- (Generalised in "Selection and default commands" below: this holds for every command, not only this one.) After commit, the faces stay selected. The executor then chains the default selection commands (`PushFaceCommand`, then `OffsetFaceCommand`), and `ed.exec()` stays pending. Clearing the selection in a `finally` around `execute()` stops this (verified: `settled:true, active:null` in every trial).
- The generic `editor.commands.DimensionCommand` re-execs a fresh DDC with `'interrupt'` and loses the seeded hit, so it gives "no effect". Call the `DimensionDistanceCommand` binding directly.
- **Which face moves: selection order decides; the last selected face moves. The hit location does not decide.** Follow-up probe 2026-11-16 (`../probes-2026-11-followups/probe-driving.json`, box 20 x 10 x 5):
  - Selection [−x, +x] (+x last), hit on −x: +x moved (max x 2420 → 2430).
  - Selection [+x, −x] (−x last), hit on +x: −x moved (min x 2400 → 2390).
  - The original `which_face_hit_on_xNeg_30` trial changed both inputs at once. The tool still selects [reference, moving] and seeds the hit on the moving face.
- Synthetic click selections add **one undo step per click** (selection history).
- `editor.selection.selected.removeAll()` does not clear hits. Call `hits.clear()` yourself.
- The SpaceInput applies typed text through a debounced callback (about 160 ms). Enter applies it immediately. Its text is interpreted in the document display unit; an explicit " mm" suffix also parsed (seen in stdout and in `p1b`/`p1c`).
- `DimensionPolylineCommand` still rejects "Operation has no effect". This happens before any factory or dialog, with or without a hit, for: the wire body, segment 0, body plus segment, and the closed triangle (`trace-polyline*.json`). The vertex variants are inconclusive: curve vertices did not register in the selection counts. This is not a pick problem; the precondition is unknown.
- `PointPicker.execute` was never called in any traced flow. Commands driven by `PointPicker` are untested.

## Recipe for `src/plasticity/operations.ts`
Run everything inside ONE `runtime.mutate` call (bindings `DimensionDistanceCommand` and `DimensionDistanceSpaceDialog`; `this` = editor). Give the CDP call timeout at least 5 s more than the internal timeouts, so a Node-side timeout cannot leave the command Awaiting. Reference implementation: `discovery/probes-2026-11-pick/js/driving-distance.js`.

1. Guard: `if (editor.executor.isBusy || editor.executor.active) throw busy`.
2. Resolve the moving face and the optional reference face from body and face ids (`view.high.faces.get(versionIds.indexOf(id))`).
3. Run `selection.selected.removeAll()` and `selection.hits.clear()`. Add the faces in the order [reference, moving], or only [moving].
4. Call `selection.hits.record(movingFace, new Vector3(...centerM), new Vector3(...normal))`. Units: metres (mm / 1000). Use the face centre from body info and its outward normal.
5. Run the command:
   ```js
   const command = new DimensionDistanceCommand(editor);
   command.remember = false;
   const orig = command.execute.bind(command);
   command.execute = async () => {
     try { return await orig(); }
     finally { editor.selection.selected.removeAll(); }
   };
   ```
   Start `ed.exec(command)` without awaiting it. Track when it settles.
6. Wait for the dialog: poll `editor.helpers.scene.traverse(o => o instanceof DimensionDistanceSpaceDialog && o.params)` with a timeout of about 2 s. If the exec promise settles first, the command rejected ("Operation has no effect"). Report that as an error.
7. Optionally read `dialog.params.refDistance` (current distance, m) for the result.
8. Set `dialog.params.distance = distanceMm / 1000`, then call `dialog.finish()`.
9. Wait until the exec promise settles, with a timeout of about 5 s. On timeout, call `executor.cancelActiveCommand()` and wait for it to settle. The undo depth stays unchanged.
10. In `finally`: `removeAll()`, then `hits.clear()`. Check `executor.active == null` and that no `input.z-space-input-focused` exists.

Expected: undo +1, and the body keeps its stable id. Commit latency is about 11–22 ms. The HUD is not involved, because the dialog is found through the object graph, not the DOM. Mechanism A uses no viewport index.

## Proposed MCP tool: `plasticity_set_driving_distance`
**Input:**
- `bodyId`
- `movingFaceId`
- `referenceFaceId` (optional; without it, Plasticity finds the opposite face)
- `distanceMm` (finite, > 0)
- `revision`
- `intent`

**Validation:**
- The revision matches.
- Both faces belong to `bodyId` and are planar.
- `referenceFaceId` is not the same face as `movingFaceId`.
- The tool always seeds the hit on the moving face. Never take a hit point from the caller, because a hit on another face is accepted silently.

**Return:** the compact mutation result (new revision, changed body), `previousDistanceMm` (from `refDistance`), `distanceMm`, and `undoSteps: 1`.

**Errors:**
- "Operation has no effect" when the command rejects (the face pair is not dimensionable).
- A timeout gives a cancelled result with the undo depth unchanged. Mark it certain, not uncertain, because the cancel ran inside the same call.

## Reusable helper (sketch): `runPickCommand`
```
runPickCommand({ commandBinding, dialogBinding, select: Item[], hits: {item, pointM, normalM?}[],
                 drive(dialog), dialogTimeoutMs = 2000, finishTimeoutMs = 5000 })
  -> { committed, undoDelta, factoryAtDialog, error? }
```
Steps: guard on `active`; clear the selection and hits; select and record; run `exec` with the wrapped `execute` and its `finally removeAll`; wait for the dialog through `helpers.scene`; call `drive`; wait to settle; on timeout call `cancelActiveCommand`; clear the selection and hits.

- **Proven with:** `DimensionDistanceCommand` (box face pair, single face, cylinder caps).
- **Untested candidates:** other commands that read the command `clickPoint` or `hits`, and any command that opens a SpaceDialog. List each one only after it is probed.
- **Not unlocked:**
  - `DimensionPolylineCommand` (blocked by an unknown precondition).
  - `PointPicker`-driven commands (never exercised; needs its own probe of `PointPicker.execute`, `onClick` and `addPickedPoint`).

## Risks and not tested
- The command accepts a hit point on an unselected face. Bad hits change the result silently.
- Which face moves: settled by the follow-up (last selected moves).
- Not tested: non-planar face pairs (for example cylinder walls), faces of a solid in a group or instance, a non-mm display unit with the key path, minimised or hidden windows, and concurrent HUD drawing during a run.
- `SelectionHitsSession` is internal API. `record(item, point, normal)` was inferred from behaviour (`record.length === 3`). It could change in an app update.
- Approach C pollutes undo history (one step per click). It also needs camera framing: setting the camera through `OrbitControls` is fragile (`setQuaternionAndTarget` produced NaN here; the smoothing and focal-offset state must be written directly).

## Follow-ups (2026-11-16, review of aff5fb3)
Scripts and raw JSON: `discovery/probes-2026-11-followups/`. Isolated instance 127.0.0.1:58932 only.
- **The executor swallows command errors.** `editor.exec()` resolves even when `execute()` throws (trials 9 and 11 here: `execError` set, `execRejected` null). The tool reads the error inside the wrapped `execute()`.
- **Equal distance, pair mode:** the command commits one Undo step anyway (bounds 2420 → 2420.0000000000005). The tool returns a no-op before running anything.
- **Equal distance, single-face mode:** the dialog opens (refDistance 0.005), then `finish()` gives "Operation has no effect"; undo delta 0. The tool reports a no-op.
- **Washer face** (40 x 40 x 5 plate, centred r 8 through hole; `probe-washer.json`):
  - `Face.FindMidpoint()` of the top face is the hole centre (2520, 20, 5): off the face.
  - Single-face mode with that hit: "Operation has no effect". With `Face.GetAnyPointOn()` as the hit: it commits.
  - Pair mode (bottom reference) commits with either hit.
  - The tool always seeds `GetAnyPointOn()`.
- **Same-direction pair** (stepped block, +z faces at z 10 and z 5): Plasticity dimensions it. Reference lower, moving upper, 8 mm: the upper face goes to z 13 (refDistance 0.005, `containsRefEntity` true). The tool allows it.
- **Dialog reference point:** `params.to` lies on the reference plane in both modes (single face +z: to z 0). The tool uses it for the post-commit plane check in single-face mode.
- Face version IDs keep their suffix across the edit (`16f920` → `17f920`); the tool finds the moved face by plane, not by ID.

## Selection and default commands (2026-11-16, Plasticity 26.1.3, isolated instance 127.0.0.1:57291)
Scratch probes over CDP (`Runtime.callFunctionOn` on the editor); not in the repository. Plasticity hides its function
sources (`toString()` returns zero-width characters), so everything here is measured behaviour, not read code.

### The defect
`plasticity_select_faces` on a face of body 1, then `plasticity_move` of another body, on the code before the guard:
the move committed, the call ended after 10,074 ms with "CDP request timed out: Runtime.callFunctionOn", and
`OffsetFaceCommand` stayed `Awaiting`. With the guard the same call took 46 ms, the face stayed selected and no
command was active.

### What the executor does
| observation | measured |
|---|---|
| A selection alone | starts no command: 200 ms after `selection.selected.add` nothing is active. |
| After a command that FINISHED, with a face selected | `PushFaceCommand` (state `None`), then `OffsetFaceCommand` or, on a fillet face, `RefilletFaceCommand`, `Awaiting` 30 to 80 ms later. The `exec()` that ran the command stays pending. |
| The same with an edge selected | `FilletShellCommand`, `Awaiting` (190 ms). |
| The same with a whole Solid, a Sheet or a curve selected | no default command; `exec()` resolved in 23 to 31 ms. |
| What tells a default command apart | `command.agent === 'automatic'`. A command built with `new editor.commands.X(editor)` has `agent === 'user'`. Both have `trigger: 'unknown'`. |
| Its resources while idle | `OffsetFaceFactory` (`_state.value` "none") and `CancellablePromise` objects. |
| `executor.cancelActiveCommand()` on it | the command reads `Cancelled` at once and leaves `executor.active` 12 microtask turns later (6 to 36 ms in all). The selection is kept. No other default command starts. The pending `exec()` resolves about 15 ms later. |
| A command that FAILS (its `execute()` throws) | no default command starts, even with a face selected. The selection goes back to the selection of the last history step (a selection made by script after that step is lost). |
| `exec()` while a default command awaits | the awaiting command is interrupted, the new command runs, and ITS `exec()` resolves when it has ended (54 ms for a 30 ms command). The first `exec()` owns the chain and starts the default command again. So the hang needs a selection with NO default command active: a selection made by a tool, or a gizmo that was cancelled. |
| `exec()` while a command of the user awaits its dialog (`FilletShellCommand`, agent `user`) | the user's command is `Cancelled`, the new command runs, its `exec()` resolves (23 ms). |
| `editor.undo()` / `redo()` | restores the selection the history state holds. With a face in it the default command chains (`OffsetFaceCommand` `Awaiting` 56 ms after the call) and the promise stays pending until that command ends (it resolved 20 ms after the cancel). Without such a selection the promise settles when the step is complete (17.6 ms for the Undo of a move). The step installs a NEW `geo.geometryModel` Map: a reference taken before the step is stale (a guard that kept one judged the old body version alive and lost a whole-body selection). |
| `executor.isBusy` | read `false` in every sample here, also while a command executed. `executor.active` is the reliable signal. |

### Selection internals
- `selection.selected.saveToMemento()` returns a `SelectionMemento { ids: Set<string>, parentsWithSelectedChildren: RefCounter }`; `new SelectionMemento(ids, parents)` works.
- An id is `<kind>:<versionId>`: `0:` edge (`0:1e113`), `1:` curve segment (`1:4s335`), `2:` face (`2:1f245`), `4:` Solid (`4:1`), `5:` Sheet (`5:2`), `7:` curve (`7:3`), `8:` curve vertex (`8:4v330`), `9:` curve control point (`9:4c1`). The number is the VERSION id, also for a whole body: a moved Solid gets a new id.
- `RefCounter` is `{ counts: Map<parentVersion, n>, values: Map<parentVersion, childIds[]>, cb }`: one entry per body with selected topology.
- `restoreFromMemento(m)` sends one `selectionChanged`. It accepts stale ids, and then `validate()`, `faces`, `solids` and `all` throw "invalid precondition: object N missing from geometry model". `removeAll()` still works on such a selection.
- `selection.selected.itemIds` lists the version ids of the selected whole bodies; `solidIds`, `sheetIds`, `curveIds`, `faceIds`, `edgeIds` are the ids without the kind prefix.
- `addById` is not `addById('<kind>:<id>')`: that call stored `2:1f244:undefined`. Not used.

### The guard (`src/plasticity/runtime.ts`, `SELECTION_GUARD_SOURCE`)
Every `runtime.mutate()` source runs inside it: entry = save the memento, cancel a default command that idles in
`Awaiting` (agent `automatic`, no factory at work), empty the selection; exit = cancel a default command a history
step chained, put the memento back without the ids whose body version is gone (a whole body follows its stable id).
While the source is pending (and not past the call's timeout), an idle default command seen on two checks 50 ms apart
is cancelled. "Idle" means untouched, see the next section. Nothing else is ever cancelled; with another command active at entry the guard stands aside (the source runs as before; afterwards the
saved selection is put back only when nothing is selected and nothing is active).

Live matrix and timing: `scripts/verify-native-selection-live.ts` (`npm run accept:native-selection`).

### A gizmo the user is editing, and a call that is given up (review round 4, 2026-11-17, instance 127.0.0.1:65175)
A real click on an edge (two CDP mouse clicks at the projected point: the first selects the Solid, the second the edge) starts `FilletShellCommand`, agent `automatic`, `Awaiting`. A real drag of its handle (press at the click point, eight moves of 6 px, hold):

| moment | factory `_state.value` | `factory.temps` | `factory.distance` | `command._isFactoryChanged` |
|---|---|---|---|---|
| after the click | `none` | 0 | 0 | false |
| mouse pressed, not moved | `none` | 0 | 0 | false |
| mid-drag | `updated` | 1 | 3.299 mm | true |
| held | `updated` | 1 | 6.598 mm | true |
| released | `updated` | 1 | 6.598 mm | true |

- The untouched state is the same for the three default commands seen (`FilletShellCommand`, `OffsetFaceCommand`, `RefilletFaceCommand`): `none`, 0 temps, `false`.
- So "idle" for the guard is: agent `automatic`, state `Awaiting`, factory `none`, no temps, `_isFactoryChanged` not true. Anything else is the user's work. The earlier test (a factory tag ending in "ing") took `updated` for idle and cancelled a held drag.
- While the preview is held (during the drag and after the release), `editor.measurements.snapshot()` throws `snapshot(): scratch active`. The state read takes that snapshot, so every tool that reads the document first fails then, with or without the guard. The runtime now words that error as "Plasticity is busy: the user is editing ...". Only a call that does not read the state reaches the guard (a raw `mutate`); a source with a command is refused there, a source without one runs and leaves the gizmo.
- `plasticity_reconcile` in that state: it leaves the gizmo, then the read it needs is refused, so it fails and the session is not reconciled. Its error names the command ("... FilletShellCommand is active and holds changes the user made (the preview of its gizmo); it was not touched ..."). `recovery.activeCommand` with `edited: true` is in a reply only when the document can be read.
- A screenshot to a file reads no state first. Its own source tests `executor.isBusy`, which is true while the preview is held, and fails with the older "Plasticity is busy". With the untouched gizmo `isBusy` is false and the screenshot is taken.
- After the user cancels the gizmo, the next edit runs (82 ms).
- With the idle gizmo: an export leaves it (the source runs no command and is not wrapped); an edit cancels it and puts the edge selection back (86 ms).

A source that does not settle within its call (700 ms timeout): the selection stays set aside (empty). A click on an edge after the timeout gets its idle gizmo and keeps it (read at 700 and 1,100 ms): the guard's watcher stopped at its budget. `reconcile` then cancels that idle gizmo (it cannot tell it from a leftover) and reports that the set-aside selection was not put back because something else is selected. When the source settles, the user's edge stays selected. With nothing selected in the meantime, `reconcile` puts the set-aside face back (`restoredSelection: 1`).

### Still true on a person's own window
- The gizmo does not come back. After an edit the selection is back and no command is active; the default command is
  not started again (calling `executor.enqueueDefaultCommand()` on a selection made by script ran `PushFaceCommand`,
  which ended and left the selection EMPTY). Click the item again.
- The selection that is put back is not in Plasticity's history. The edit's own history step holds an empty selection.
  So a later command that is cancelled or fails (Escape on a gizmo, a refused edit in the UI) sends the selection back
  to that empty state, and Undo of the edit in the UI restores the document without the earlier selection.
- The click points (`selection.hits`) are not saved or put back; the Dimension command clears them.
- `plasticity_reconcile` cancels an idle, untouched default gizmo even when the person has only just clicked (it cannot tell it from the leftover of a timed-out call). The selection stays; click again for the gizmo.
- While a person holds a preview in a gizmo, no tool can read the document (Plasticity refuses the snapshot), so the agent cannot work until the person finishes or cancels it. A multi-step tool that is already running when the person starts to drag fails at its next step, and its own undo of the steps so far is refused in the same way: the steps stay, and the error says so.
- A command of the person that awaits its dialog is still interrupted by an edit (Plasticity does that in `exec()`,
  as before the guard): live, a `FilletShellCommand` (agent `user`) awaiting its dialog read `Cancelled` after a
  `plasticity_move`, and what was typed into the dialog is lost. The guard does not cancel it. The interrupt sends the
  selection back to that of the last history step; when that leaves nothing selected the guard puts the saved
  selection back, otherwise Plasticity's own selection (and the gizmo it starts for it) stays.
- (Changed in review round 4.) Calls that run no command (exports, section analyses, save a copy, the label refresh of
  a state read) are not wrapped in the guard any more: they do not touch the selection or a gizmo.
- A command of the server that is still running when its call returns (a pick command that could not be cancelled;
  the session is uncertain then) keeps the selection empty until it ends; the guard puts it back then (watched for
  15 s).
- A click in the window while an edit runs is a command of its own: Plasticity's executor interrupts whatever runs.
  Not measured.
- Window state: all probes ran with `document.visibilityState` "visible" and `document.hasFocus()` false. Timers of 2
  ms fired after 3 to 6 ms. A hidden window throttles timers; the guard waits without timers first (microtask turns).
