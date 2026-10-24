# Print-in-place spring push button

Built by `build.ts` through the MCP server in a new blank document. The result is kept, and nothing
was saved. Run it with Plasticity open on an empty document:

```sh
PLASTICITY_CDP_URL=http://127.0.0.1:9223 node discovery/spring/build.ts
```

Files: `push-button.3mf` (one body, exported from Plasticity), `button-iso.png`, `button-top.png`,
`button-section.png`, `button-iso-final.png`, `build-result.json`.

## Design (millimeters, Z up, printed in this orientation)

| Part | Size |
|---|---|
| Frame | 40 × 40 × 10.4 block; Ø30 pocket from the bed up to z 8.4; a 2 mm top plate with a Ø10.8 hole; 4 × Ø3.2 mounting holes at ±16 |
| Plunger | Ø10 column from the bed to z 12.4, with a 45° cone cap from Ø10 to Ø18, 4 mm tall (top at z 16.4) |
| Spring | 3 control-point spiral arms, each sweeping 240° from the plunger to the pocket wall; 1.2 mm in Z × 2.0 mm wide; on the bed (z 0 to 1.2); 12 root edges filleted r0.8 |
| Clearances | 0.4 mm radial between the column and the plate hole; 2 mm between the cap and the plate; about 3 mm between neighbouring arm turns |
| Travel stop | The cone underside meets the plate-hole edge after about 2.2 mm of travel |

**Change from the brief.** The brief asked for beams 1.2 mm thick × 4 mm tall. With the plunger
moving in Z, a 4 mm-tall beam bends about its stiff axis: about 66 N/mm and about 160 MPa at 2 mm in
PLA, which is far past yield. The beams here are 1.2 mm in the travel direction and 2.0 mm wide.

**Printability.** The spring and plunger start on the bed. The top plate bridges about 10 mm over the
pocket. The cap is a 45° cone, so it needs no support. The bottom is open, so the panel the button is
mounted on needs a hole of at least Ø11 under the plunger to allow 2 mm of travel.

## Spring estimate (hand calculation; the repo's strength tools have no spiral-flexure method)

Each arm is treated as a guided beam, fixed at the frame and at the plunger, which moves straight
down: k = 12EI/L³ per arm, I = w·t³/12, and bending stress σ = 6Eδ(t/2)/L². Arm length L = 43.3 mm
(the arc length of the control polygon; the real curve is a little shorter, so it is a little stiffer).
w = 2.0 mm, t = 1.2 mm, 3 arms, δ = 2 mm.

| Material (E) | Stiffness | Force at 2 mm | Max bending stress at 2 mm |
|---|---|---|---|
| PLA (3.5 GPa) | 0.45 N/mm | 0.9 N | 13 MPa |
| PETG (2.1 GPa) | 0.27 N/mm | 0.5 N | 8 MPa |

The estimate leaves out:
- torsion in the curved arms, which makes the spring softer;
- the stiffening effect of the root fillets;
- print orientation: the arms are printed flat, so layer lines run along the beam (good);
- creep.

Stress is about 25% of PLA yield (~50 MPa), so the spring should survive many presses. PETG is more
forgiving.

## Run numbers

- 30 MCP calls, 4.1 s in total (frame 0.3 s, plunger 0.16 s, arms 0.4 s, joining and fillets 0.33 s,
  tool checks 0.37 s, views 1.4 s, 3MF 0.2 s).

## Today's additions, checked live

| Feature | Result |
|---|---|
| `plasticity_boolean` `createdEdges` | Worked: 48 edges reported. A `find_edges` filter on those ids (vertical, 1.2 mm) picked the 12 root edges, and the fillet took them |
| `cut_with_curves` `keep: "larger"` | Worked: one part left, the 14 mm side of a 20 mm scratch box |
| `plasticity_undo` `steps` | Worked: one call undid 4 steps, back to the exact body set |

## Pain points, and what was done

1. **`create_cone` adds two bodies** (the Solid and its editable profile Wire), and `$1.added[0]` was
   the Wire, so the union failed with `PK_ERROR_wire_body`. Fixed: batch now has `addedSolids`,
   `addedSheets` and `addedWires` references (with a test).
2. **`createdEdges` could not be filtered inside a batch.** Fixed: `find_edges` takes an `edgeIds` set
   to narrow down to, and batch steps echo `createdEdges` (with tests).
3. **Body bounds are loose around offset surfaces.** The arms report z −0.23 to 1.43, but their faces
   span exactly 0 to 1.2. Check faces before trusting body bounds for clearances.
4. **The section analysis did not clip the screenshot.** The plane shows, but the model is not cut.
   `button-section.png` is a side view with the plane overlay, not a true section.
5. **No ellipse, spiral or helix-in-plane helper.** The script computes the spiral control points itself.
