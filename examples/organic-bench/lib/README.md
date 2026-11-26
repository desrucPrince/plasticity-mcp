# Organic surfacing building blocks (Plasticity MCP)

Python helpers that drive the Plasticity MCP server through the daemon in `../tools/daemon2.mjs`. Port: env `PLD_PORT`. They were proven on Plasticity 26.1.3 in isolated windows.

## The rule that makes G2 reliable

`plasticity_loft_curves` with **edge profiles** (`{bodyId, edgeId}`) and `curvature: "clamped"` makes the new surface G2 to each edge's face, by construction. The continuity report reads interior relative G2 0.000 on curved joins (0.025, 0.0167, 0.0264 /mm across).

Guides keep that G2 only if they are consistent with the clamped face at the corners. A guide must leave the profile tangent to the face, with the face's normal curvature in that direction:
- Consistent, G2 kept: the base line under a flank whose bottom boundary is the same straight line.
- Inconsistent, G2 lost: a straight band edge leaving a curved flank corner. Measured: relative G2 0.68 with the guide, 0.001 without it.

A loft is G2 only across its two end profiles. Its two other sides (guides) are positional. Lay out a model so that every smooth join is a profile join, and keep guides for creases (face rims, base outlines).

## Blocks (`blocks.py`)

| Block | What it does |
|---|---|
| `g2_loft(profiles, guides, curvature='clamped')` | Loft through edge profiles (tuples `(body, edge)`, G2) and Wire profiles (ids, positional). |
| `bridge_g2(w1, w2)` | G2 bridge between the nearest ends of two Wires. Use it to build G2 outlines and meridians. |
| `join_curves(ids)` | Join Wires into one. |
| `revolve(wire)` | Surface of revolution. A G2 meridian gives G2 joins between the revolved faces. |
| `extrude(wire, d, dir)` | Sheet from an outline. A G2 outline gives G2 wall joins. |
| `planar_cap(body, edges)` | G0 Indie patch of a planar hole (an intended crease, for example the base). |
| `mirror_join(body)` | Mirror at x = 0 and join. |
| `join(ids)` | Sew sheets. A closed result becomes a Solid. |
| `plane_curve(plane, pts, **ends)` | 2D control or interpolate curve. `startTangent` and `startCurvatureZero` give G2-ready ends. |
| `bspline.fit(points, n)` | Least-squares cubic B-spline (fixed ends) for a smooth section from probed points. |

`gate.py`: `evaluate(body, plan)` checks a body against a per-edge continuity plan. Selectors are `zRing`, `xPlaneEdge`, `vertical`, `nearPointMm`, `endsNearMm`, `edgeIds` and `rest`. Targets are `G2`, `G1`, `G0`, `sharp` and `any`. It returns pass/fail per edge and the first failure. When the server has `plasticity_check_continuity_plan` (branch `feat/surface-consistency`), use that instead: it carries the mixed G2 tolerance and the native-maximum cross-check.

## Recipes (`../shapes`)

| Recipe | Smooth joins | Status |
|---|---|---|
| `s1_softbox` | 8 wall joins, G2 by a G2 outline, extruded | passes, ±5 % sweep |
| `s2_blend` | 2 joins, G2 by a clamped edge loft | passes, ±5 % sweep |
| `s3_bottle` | body/shoulder/neck, G2 by a G2 meridian, revolved | passes, ±5 % sweep |
| `s5_dome` | ring/dome, Indie patch g2 on a circular hole | passes, ±5 % sweep |
| `s0*` | negative controls: curvature jump, 0.3° crease, old speaker flank/side | gate fails them, as required |
| `s4_speaker` | flank, symmetric shell and wrap lofts | see `../REPORT.md` |

## Known native limits (26.1.3)

- A loft between closed (periodic) edges fails with error 21555 unless `curvature: "natural"`. Use a revolved G2 meridian for rotational shapes instead.
- `plasticity_mirror` on Wires throws `TypeError: undefined is not a function`. To mirror a plane curve, create it again with a mirrored frame.
- A loft fails with "A guide curve is not touching a profile" when a profile end is only near a guide. Put section ends on the guide with `evaluate_curve_segments` (exact points), not on a sampled polyline.
