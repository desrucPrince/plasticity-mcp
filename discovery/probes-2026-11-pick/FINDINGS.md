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
- After commit, the faces stay selected. The executor then chains the default selection commands (`PushFaceCommand`, then `OffsetFaceCommand`), and `ed.exec()` stays pending. Clearing the selection in a `finally` around `execute()` stops this (verified: `settled:true, active:null` in every trial).
- The generic `editor.commands.DimensionCommand` re-execs a fresh DDC with `'interrupt'` and loses the seeded hit, so it gives "no effect". Call the `DimensionDistanceCommand` binding directly.
- **Which face moves.** The `which_face_hit_on_xNeg_30` trial reversed the selection order and moved the hit to −x. The −x face moved (min x 1989.9999999999995). The test changed both inputs at once, so it does not show which input decides. Recommended: select [reference, moving] and seed the hit on the moving face.
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
- Which face moves, when two faces are selected, is decided by selection order and/or the hit. These were not separated.
- Not tested: non-planar face pairs (for example cylinder walls), faces of a solid in a group or instance, a non-mm display unit with the key path, minimised or hidden windows, and concurrent HUD drawing during a run.
- `SelectionHitsSession` is internal API. `record(item, point, normal)` was inferred from behaviour (`record.length === 3`). It could change in an app update.
- Approach C pollutes undo history (one step per click). It also needs camera framing: setting the camera through `OrbitControls` is fragile (`setQuaternionAndTarget` produced NaN here; the smoothing and focal-offset state must be written directly).
