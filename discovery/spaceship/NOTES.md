# Spaceship build through the MCP server

A ~300 mm fighter built in Plasticity 26.1.3 by `build.ts`, mostly with `plasticity_batch`. Run it
from the repo root with Plasticity open on a blank test document:

```sh
PLASTICITY_CDP_URL=http://127.0.0.1:9223 node discovery/spaceship/build.ts
```

It first undoes back to undo depth 0 and refuses unless only the startup cube (or nothing) is left.
It never saves. Results: `build-result.json`. Views: `spaceship-iso.png`, `spaceship-top.png`,
`spaceship-side.png`, `spaceship-nose-on.png`.

## What it builds

| Part | How |
|---|---|
| Fuselage | 6 closed control-point sections in YZ planes, lofted with natural (G2) curvature, capped |
| Canopy | 4 control-point sections, lofted and capped, separate body |
| Wings | swept polyline planform, two-sided extrude to a 4 mm slab, all edges filleted r1.8, mirrored |
| Wing root | union with the fuselage, 16 junction edges filleted r3 |
| Nacelles | 3 circles lofted and capped, nose cut at a slant with `cut_with_curves`, offcut deleted, mirrored |
| Tail fins | polyline profile, two-sided extrude, edges filleted, rotated 18°, moved, mirrored |
| Panel line | `knife_curve` across the nose at x = 255 |

## Numbers (last run)

- Total 11.6 s, 114 MCP calls. About 90 of the calls are the baseline step, which undoes the previous
  run one step at a time (a status call and an undo for each history step).
- The build itself: about 24 calls and 4.7 s. Each part is one batch, and mirrors and cleanups are one
  more each.
- Screenshots: 2.4 s for four views.

## Pain points, and what was done

1. **The running MCP server had old code.** Claude Code's own plasticity server started before the
   latest commits, so extrude reverse distances went the wrong way and batch replies were large.
   Code changes need `/mcp` → reconnect. The session server also held the window lock, so a second
   server could not connect until it was stopped.
2. **Batch did not fill `revision` for union-schema tools** such as `plasticity_create_polyline`.
   Fixed with a test (commit c1aee42).
3. **Batch replies were 9–10 KB** even for a visibility change, because they repeated the whole scene.
   Fixed: the default reply lists only what changed, and each step shows its new bodies with bounds
   (`verbose: true` restores the old reply).
4. **Two-sided extrude sign.** The native second distance runs along the extrude direction. A probe
   (`probe-reverse-extrude.ts`) confirmed the current code is right for every case tried.
5. **The intake cut keeps the "wrong" part by default.** The cut leaves one part in the original
   body and adds the other, and which part stays depends on the cutter. Fixed: `cut_with_curves` and
   `cut_with_faces` take `keep: "larger" | "smaller" | "both"` (by bounding-box volume, one target).
6. **View names.** `plasticity_set_view` "right" looks at the nose of an X-forward model, and
   "front" shows its side. The script now labels the files by what they show.
7. **Rerunning needed many undos.** Fixed: `plasticity_undo` and `plasticity_redo` take `steps`, so
   the baseline reset is one call. build.ts uses it.
8. **Section points were computed by hand.** There is no ellipse or "section from width/height"
   helper, so the script computes control points itself.
9. **Junction edges were found by bounds.** Fixed: `plasticity_boolean` returns `createdEdges`
   (edges whose geometry did not exist before, i.e. the seams plus trimmed input edges), and batch
   steps can use them: `"$2.result.createdEdges[*].edgeId"`.
10. **A hidden startup cube still framed the view.** After `set_visibility` false the cube stayed in
    the viewport until it was deleted. The script deletes it instead.
