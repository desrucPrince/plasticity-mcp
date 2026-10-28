# neoRC 11 rig-ready Blender scene

Source: Plasticity `RC1BaseMeshV19_export.plasticity` (same geometry as V18), exported by
`../export/export-rig.ts` to `../export/v18-rig/` (OBJ of the 316 visible source bodies, 0.2 mm chord / 4°, plus
`bodies.json`, `instances.json` for the 336 linked and mirrored copies, `gear_pivots.json`, `gyro_pivots.json`, and a STEP).
The 217 MB OBJ is not in git; rerun the export script to recreate it.

Rebuild: `/Applications/Blender.app/Contents/MacOS/Blender -b -P discovery/neorc11/blender-rig/prepare_rig.py` (Blender 5.2.3).

## Space
Metres, Z up, nose −Y, ground Z 0, ship's left = +X (`.L`). From Plasticity: `(x, y, z)_m = (−x, −y, z)_mm × 0.001`.
Belly 2.04 m, lowest ship point 1.968 m (belly clamps), roof 5.29 m. Bounds X ±4.904, Y −7.903..7.435, Z 0..5.29.

## Rest pose = deployed
Every joint object has its origin at its joint and local Z on its hinge or slide axis, with a zero local transform at
rest. Animate `rotation_euler.z` (hinges, degrees) or `location.z` (slides, metres). `rig_manifest.json` lists each
object's parent, pivot, axis, motion type, deployed (0) and stowed values. `RIG_PIVOTS` holds a `PIV_*` arrows empty at every joint.

Stow order: 1) telescope: `stage_mid` +0.570, `slider` +0.230; 2) `strut_upper` −90°; 3) `foot` +90°;
4) doors close: `door_in`/`door_out` ∓90° to shut. Lift (separate): `LIFT_ram_FR_s1/s2/s3` +0.680/+0.670/+0.690 m
(2.040 m in all, platform flush with the belly); the other three rams copy FR through drivers.

## Chains
- Leg: `HULL_body.R` → `GEAR_xx_top_block` → `strut_upper` (hinge) → `stage_mid` (slide) → `slider` (slide) → `fork`, `knuckle` → `foot` (hinge).
- Actuator: `actuator_body` (on top_block) and `actuator_rod` (on strut_upper) aim at each other with Damped Track (`TGT_*` empties).
- Side brace: rebuilt as `brace_upper` (on top_block) and `brace_lower` with the knee (on strut_upper), since the CAD brace is one united solid.
  It needs 2-bone IK or a Damped Track pair to the knee point (`TGT_GEAR_xx_brace_knee`). The knee point is in the manifest.
- Doors: `GEAR_xx_door_in/out` → `HULL_body.R`, hinged at their hinge lines.
- Lift: `LIFT_housing_xx` (fixed) → `LIFT_ram_xx_s1` → `s2` → `s3`. `LIFT_platform` rides on `LIFT_ram_FR_s3` and carries the ribs, edge lights and rails.
- Gyro: `GYRO_outer_gimbal` (hinge) → `GYRO_inner_gimbal` (hinge) → `GYRO_rotor` (spin), which carries the rim light, core and spokes. Trunnions and base bolts are fixed.

## Notes
- 653 mesh objects, 2.14 M triangles. The bolts, rivets and gyro base bolts are decimated ×0.2, the tread ribs ×0.3, the rails ×0.5 and the footpads ×0.4 (then smooth by angle 30°).
  Everything else keeps the CAD tessellation and normals, so the 1.5–3 mm rounds still read. The mirrored copies' normals are flipped back outward.
- Placeholder materials: PAINT, GUNMETAL, CHROME, GLASS (headlights; there is no separate canopy body), DARK_LINER, CYAN_EMISSIVE, RUBBER.
- `SCALE_REF` (two 1.8 m figures) is hidden and excluded from render. It is also exported on its own as `scale_ref.glb`.
- `neoRC11_rigready.glb` is Draco-compressed and Y-up (the glTF convention).
- Checks (stowed): each leg fits its bay with ≥ 30 mm (40 mm at the sides, 50 front and rear, 42 above the closed doors, 30 below the ceiling). The doors and platform are flush at Z 2.040. The rail clears the shaft ceiling by 1080 mm, and the ram tops are at 2.91 m inside the 3.5 m housings.
