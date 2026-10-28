# neoRC 11 rig prep (Blender 5.2, headless, rerunnable):
#   /Applications/Blender.app/Contents/MacOS/Blender -b -P discovery/neorc11/blender-rig/prepare_rig.py
# Input: ../export/v18-rig/ (OBJ of the 316 visible source bodies in millimetres, Z up, nose +Y; bodies.json;
# instances.json with the linked and mirrored copies; gear_pivots.json; gyro_pivots.json).
# Blender space: metres, Z up, nose -Y, ground Z 0: (x, y, z)_blender = (-x, -y, z)_plasticity * 0.001.
# Output: neoRC11_rigready.blend / .glb, scale_ref.glb, rig_manifest.json, check-*.png. Every moving part has its
# origin and orientation at its joint (local Z = hinge or slide axis) and a zero rest pose = deployed; stowed values
# are local Z rotations (deg) or local Z slides (m). The CAD normals from the OBJ are kept (mirrored copies flipped).
import json
import math
import os
import re
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "export", "v18-rig")
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
bodies = json.load(open(os.path.join(SRC, "bodies.json")))
insts = json.load(open(os.path.join(SRC, "instances.json")))["instances"]
gear = json.load(open(os.path.join(SRC, "gear_pivots.json")))
gyro = json.load(open(os.path.join(SRC, "gyro_pivots.json")))

C = Matrix.Diagonal((-0.001, -0.001, 0.001, 1.0))  # plasticity mm -> blender m, turned 180° about Z
CI = C.inverted()
def P2B(p): return Vector((-p[0] / 1000.0, -p[1] / 1000.0, p[2] / 1000.0))
def A2B(a): return Vector((-a[0], -a[1], a[2])).normalized()
def B2P(v): return [round(-v.x * 1000, 2), round(-v.y * 1000, 2), round(v.z * 1000, 2)]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"

# ---------------------------------------------------------------- import and match OBJ objects to bodies
bpy.ops.wm.obj_import(filepath=os.path.join(SRC, "neorc11_v18.obj"), global_scale=1.0, forward_axis="Y", up_axis="Z")
imported = [o for o in scene.objects if o.type == "MESH"]
base = lambda n: re.sub(r"\.\d+$", "", n or "")
def bbox(o):
    import numpy as np
    n = len(o.data.vertices); a = np.empty(n * 3); o.data.vertices.foreach_get("co", a); a = a.reshape(-1, 3)
    M = np.array(o.matrix_world); w = a @ M[:3, :3].T + M[:3, 3]
    return list(w.min(0)), list(w.max(0))
def bbox_cached(o):
    vs = [o.matrix_world @ Vector(c) for c in o.bound_box]
    return [min(v[i] for v in vs) for i in range(3)], [max(v[i] for v in vs) for i in range(3)]
pairs = []
for o in imported:
    lo, hi = bbox(o)
    for b in bodies:
        if base(b["name"]) != base(o.name): continue
        cost = 0 if b["name"] == "rc11_hull" else sum(abs(lo[i] - b["boundsMm"]["min"][i]) + abs(hi[i] - b["boundsMm"]["max"][i]) for i in range(3))
        pairs.append((cost, o.name, b["id"]))
pairs.sort()
obj_of, used_o = {}, set()
for cost, on, bid in pairs:
    if on in used_o or bid in obj_of: continue
    obj_of[bid] = bpy.data.objects[on]; used_o.add(on)
unmatched = [o.name for o in imported if o.name not in used_o]
assert len(obj_of) == len(bodies) and not unmatched, (len(obj_of), len(bodies), unmatched[:5])
body_by_id = {b["id"]: b for b in bodies}

recs = []  # one per Blender object: {obj, src, inst, mirrored}
for bid, o in obj_of.items():
    o.matrix_world = Matrix.Identity(4)
    o.data.transform(C)
    o.data.update()
    recs.append({"obj": o, "src": bid, "inst": None, "mirrored": False})
for i in insts:
    e = i["matrixWorldMm"]
    M = Matrix([[e[c * 4 + r] for c in range(4)] for r in range(4)])
    MB = C @ M @ CI
    src = obj_of[i["source"]]
    me = src.data.copy()
    me.transform(MB)
    mir = MB.to_3x3().determinant() < 0
    if mir: me.flip_normals()
    o = bpy.data.objects.new(src.name + "_inst", me)
    scene.collection.objects.link(o)
    recs.append({"obj": o, "src": i["source"], "inst": i["id"], "mirrored": mir})
for r in recs:
    lo, hi = bbox(r["obj"])
    r["cB"] = Vector([(lo[k] + hi[k]) / 2 for k in range(3)])
    r["cP"] = B2P(r["cB"])
    r["base"] = base(body_by_id[r["src"]]["name"])

# ---------------------------------------------------------------- materials
def mat(name, rgb, rough, metal, emit=None, alpha=1.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*rgb, 1); p.inputs["Roughness"].default_value = rough; p.inputs["Metallic"].default_value = metal
    if emit: p.inputs["Emission Color"].default_value = (*emit, 1); p.inputs["Emission Strength"].default_value = 6.0
    if alpha < 1: p.inputs["Alpha"].default_value = alpha
    m.diffuse_color = (*rgb, 1) if not emit else (*emit, 1)
    return m
MATS = {
    "PAINT": mat("PAINT", (0.012, 0.03, 0.09), 0.28, 0.6),
    "GUNMETAL": mat("GUNMETAL", (0.03, 0.033, 0.038), 0.35, 0.8),
    "CHROME": mat("CHROME", (0.72, 0.74, 0.77), 0.08, 1.0),
    "GLASS": mat("GLASS", (0.6, 0.7, 0.8), 0.05, 0.0, alpha=0.35),
    "DARK_LINER": mat("DARK_LINER", (0.004, 0.005, 0.006), 0.75, 0.1),
    "CYAN_EMISSIVE": mat("CYAN_EMISSIVE", (0.05, 0.6, 0.8), 0.1, 0.0, emit=(0.11, 0.8, 1.0)),
    "RUBBER": mat("RUBBER", (0.012, 0.012, 0.013), 0.85, 0.0),
}
def material_for(b):
    n = b.replace("rc11_", "")
    if re.search(r"light|glow|RimLight|Core", n): return "CYAN_EMISSIVE"
    if re.search(r"headlight", n): return "GLASS"
    if re.search(r"liner", n): return "DARK_LINER"
    if n == "lg_foot": return "RUBBER"
    if re.search(r"slider|actuator_rod|ram_stage|hatch_rail|pod_trim|lg_stage|grille_bar|trim$", n): return "CHROME"
    if re.search(r"^hull$|door|platform$|sill|hover_pad", n): return "PAINT"
    return "GUNMETAL"
for r in recs:
    m = MATS[material_for(r["base"])]
    r["mat"] = m.name
    r["obj"].data.materials.clear(); r["obj"].data.materials.append(m)

# ---------------------------------------------------------------- naming and collections
def coll(name, parent=None):
    c = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if c.name not in (parent or scene.collection).children: (parent or scene.collection).children.link(c)
    return c
COL = {k: coll(k) for k in ["HULL", "DETAILS", "GEAR", "DOORS", "LIFT", "GYRO", "RIG_PIVOTS", "SCALE_REF"]}
LEGS = {}
for c in ["FL", "FR", "RL", "RR"]: LEGS[c] = coll("GEAR_" + c, COL["GEAR"])
def corner(p): return ("F" if p[1] > 0 else "R") + ("R" if p[0] > 0 else "L")  # plasticity +X = ship's right
def side(p, tol=1.0): return "" if abs(p[0]) < tol else (".R" if p[0] > 0 else ".L")
GEARNAME = {"trunnion": "top_block", "strut": "strut_upper", "stage": "stage_mid", "slider": "slider", "fork": "fork", "knuckle": "knuckle",
            "foot": "foot", "actuator": "actuator_body", "actuator_rod": "actuator_rod", "door_inner": "door_in", "door_outer": "door_out"}
detail_idx, taken = {}, set()
for r in sorted(recs, key=lambda r: (r["base"], r["src"], r["inst"] or 0)):
    b, p = r["base"], r["cP"]
    n = b.replace("rc11_", "")
    if b == "rc11_hull": name, col = "HULL_body" + side(p), "HULL"
    elif b == "rc11_ref_human": name, col = "SCALE_REF_human", "SCALE_REF"
    elif n.startswith("lg_liner"): name, col = f"HULL_bay_liner_{corner(p)}", "HULL"
    elif n.startswith("lg_") and n[3:] in GEARNAME:
        part = GEARNAME[n[3:]]
        name, col = f"GEAR_{corner(p)}_{part}", ("DOORS" if part.startswith("door") else "LEG")
    elif n == "lg_brace": name, col = f"OLD_brace_{corner(p)}", "LEG"
    elif n.startswith("hatch_liner_"): name, col = f"HULL_shaft_liner_{n[12:]}{side(p)}", "HULL"
    elif n == "hatch_ceiling_light": name, col = f"HULL_shaft_light_panel{side(p)}", "HULL"
    elif n == "hatch_light": name, col = f"HULL_shaft_lip_strip{side(p)}", "HULL"
    elif n == "hatch_ram_housing": name, col = f"LIFT_housing_{corner([p[0], p[1] - 2800, 0])}", "LIFT"
    elif n.startswith("hatch_ram_stage_"): name, col = f"LIFT_ram_{corner([p[0], p[1] - 2800, 0])}_s{n[-1]}", "LIFT"
    elif n == "hatch_platform": name, col = "LIFT_platform", "LIFT"
    elif n == "hatch_rib": name, col = "LIFT_rib", "LIFT"
    elif n == "hatch_platform_light": name, col = f"LIFT_edge_light{side(p)}", "LIFT"
    elif n == "hatch_rail": name, col = f"LIFT_rail{side(p)}", "LIFT"
    elif n.startswith("Gyro_"):
        g = {"Gyro_OuterGimbal": "outer_gimbal", "Gyro_InnerGimbal": "inner_gimbal", "Gyro_Rotor": "rotor", "Gyro_RimLight": "rim_light", "Gyro_Core": "core"}.get(n)
        if g: name = "GYRO_" + g
        elif n == "Gyro_Trunnion": name = "GYRO_trunnion" + side(p)
        else:
            k = detail_idx.setdefault(b, {}); k[r["src"]] = k.get(r["src"], len(k) + 1)
            name = f"GYRO_{'base_bolt' if n == 'Gyro_Bolt' else 'spoke'}_{k[r['src']]:02d}"
        col = "GYRO"
    else:
        k = detail_idx.setdefault(b, {})
        if r["src"] not in k: k[r["src"]] = len(k) + 1
        stem = n.replace("p_", "")
        name, col = f"DETAIL_{stem}_{k[r['src']]:03d}{side(p)}", "DETAILS"
    if name == "LIFT_rib" or name in taken:
        j = 1
        while f"{name}_{j:02d}" in taken: j += 1
        name = f"{name}_{j:02d}"
    taken.add(name)
    r["name"] = name
    o = r["obj"]; o.name = name; o.data.name = name
    target = LEGS[corner(p)] if col == "LEG" else COL[col]
    for c in list(o.users_collection): c.objects.unlink(o)
    target.objects.link(o)
    r["collection"] = target.name
OB = {r["name"]: r for r in recs}
# ribs renumbered front to back
ribs = sorted([r for r in recs if r["name"].startswith("LIFT_rib")], key=lambda r: r["cB"].y)
for k, r in enumerate(ribs): r["obj"].name = f"TMP_rib_{k}"
for k, r in enumerate(ribs): r["obj"].name = f"LIFT_rib_{k + 1:02d}"; r["obj"].data.name = r["obj"].name
OB = {r["obj"].name: r for r in recs}
for r in recs: r["name"] = r["obj"].name

# ---------------------------------------------------------------- triangle budget: coarsen the many tiny fasteners
# (bolts and rivets are ~4.5k triangles each from the 0.2 mm chord), tread ribs, rail and the footpad bolt ring;
# the hull and the visible rounds keep their CAD tessellation and normals.
DECIMATE = [(r"^DETAIL_(bolt_|rivet_)|^GYRO_base_bolt", 0.2), (r"^LIFT_rib", 0.3), (r"^LIFT_rail", 0.5), (r"^GEAR_.._foot$", 0.4)]
decimated = {}
for r in recs:
    ratio = next((q for pat, q in DECIMATE if re.search(pat, r["obj"].name)), None)
    if not ratio: continue
    o = r["obj"]; before = len(o.data.polygons)
    m = o.modifiers.new("decimate", "DECIMATE"); m.ratio = ratio; m.use_collapse_triangulate = True
    with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o]):
        bpy.ops.object.modifier_apply(modifier="decimate")
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(30))
    decimated[o.name] = ratio

# ---------------------------------------------------------------- brace links rebuilt as separate parts (the CAD brace is one united solid)
def cyl(name, a, b, radius, coll_, matname):
    a, b = Vector(a), Vector(b); d = b - a
    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=radius, depth=d.length, location=(a + b) / 2)
    o = bpy.context.active_object; o.name = name; o.data.name = name
    o.rotation_mode = "QUATERNION"; o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    mb = o.modifiers.new("bevel", "BEVEL"); mb.width = 0.004; mb.segments = 3; mb.limit_method = "ANGLE"
    bpy.ops.object.modifier_apply(modifier="bevel")
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(30))
    for c in list(o.users_collection): c.objects.unlink(o)
    coll_.objects.link(o); o.data.materials.append(MATS[matname])
    return o
def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]; bpy.ops.object.join()
    o = bpy.context.active_object; o.name = name; o.data.name = name; return o
PIVZ, CEIL, FRONT, REAR = 2250.0, 2440.5, 4400.0, -3200.0
BRACE = {}
for c in ["FL", "FR", "RL", "RR"]:
    sx = 1 if c[1] == "R" else -1; yp = FRONT if c[0] == "F" else REAR; x = sx * 1600
    U, K, S = [x, yp - 760, CEIL], [x, yp - 420, PIVZ - 370], [x, yp - 90, PIVZ - 530]
    up = cyl(f"GEAR_{c}_brace_upper", P2B(U), P2B(K), 0.042, LEGS[c], "GUNMETAL")
    lo_ = cyl(f"GEAR_{c}_brace_lower", P2B(K), P2B(S), 0.042, LEGS[c], "GUNMETAL")
    kn = cyl(f"GEAR_{c}_brace_knee_tmp", P2B([x - 77, K[1], K[2]]), P2B([x + 77, K[1], K[2]]), 0.059, LEGS[c], "GUNMETAL")
    lo_ = join([lo_, kn], f"GEAR_{c}_brace_lower")
    BRACE[c] = {"U": U, "K": K, "S": S, "upper": up, "lower": lo_}
    old = OB.get(f"OLD_brace_{c}")
    if old: bpy.data.objects.remove(old["obj"]); recs.remove(old)
    for o, nm in ((up, up.name), (lo_, lo_.name)):
        r = {"obj": o, "src": None, "inst": None, "mirrored": False, "name": nm, "base": "rebuilt brace link", "mat": "GUNMETAL", "collection": LEGS[c].name}
        recs.append(r)
OB = {r["obj"].name: r for r in recs}

# ---------------------------------------------------------------- joints
def frame(origin, z):
    z = z.normalized(); ref = Vector((0, 0, 1)) if abs(z.z) < 0.9 else Vector((1, 0, 0))
    x = (ref - z * ref.dot(z)).normalized(); y = z.cross(x)
    m = Matrix((x, y, z)).transposed().to_4x4(); m.translation = origin; return m
JOINT = {}  # name -> dict(frame, parent, motion, stowed, order, note)
def set_joint(name, origin_B, axis_B, parent, motion, stowed=0.0, order=None, note=None, target=None):
    r = OB[name]; o = r["obj"]; F = frame(origin_B, axis_B)
    o.data.transform(F.inverted() @ o.matrix_world); o.matrix_world = F
    JOINT[name] = {"F": F, "parent": parent, "motion": motion, "stowed": stowed, "order": order, "note": note, "target": target}
legs_json = {l["part"]: l for l in gear["legs"]}
doors_json = {d["part"]: d for d in gear["doors"]}
for c in ["FL", "FR", "RL", "RR"]:
    sx = 1 if c[1] == "R" else -1; yp = FRONT if c[0] == "F" else REAR; x = sx * 1600
    lj = legs_json[f"leg {'front' if c[0] == 'F' else 'rear'} {'+X' if sx > 0 else '-X'}"]
    g = lambda part: f"GEAR_{c}_{part}"
    hingeB = A2B(lj["axis"])
    set_joint(g("top_block"), P2B([x, yp, PIVZ]), hingeB, "HULL_body.R", "fixed")
    set_joint(g("strut_upper"), P2B([x, yp, PIVZ]), hingeB, g("top_block"), "hinge", lj["stowedDeg"], 2, "leg retract")
    set_joint(g("stage_mid"), P2B([x, yp, PIVZ - 650]), Vector((0, 0, 1)), g("strut_upper"), "slide", 0.570, 1, "telescope: middle stage into the strut")
    set_joint(g("slider"), P2B([x, yp, PIVZ - 1210]), Vector((0, 0, 1)), g("stage_mid"), "slide", 0.230, 1, "telescope: slider into the middle stage")
    set_joint(g("fork"), P2B([x, yp, 340]), Vector((0, 0, 1)), g("slider"), "fixed")
    set_joint(g("knuckle"), P2B([x, yp, 110]), A2B(lj["foot"]["axis"]), g("slider"), "fixed")
    set_joint(g("foot"), P2B([x, yp, 110]), A2B(lj["foot"]["axis"]), g("knuckle"), "hinge", lj["foot"]["stowedDeg"], 3, "foot folds flat about the knuckle")
    br = BRACE[c]
    set_joint(g("brace_upper"), P2B(br["U"]), P2B(br["K"]) - P2B(br["U"]), g("top_block"), "constraint", note="2-link side brace, upper link: mount on the bay ceiling; needs 2-bone IK (or Damped Track) to the knee", target={"knee_m": list(P2B(br["K"])), "pairs_with": g("brace_lower")})
    set_joint(g("brace_lower"), P2B(br["S"]), P2B(br["K"]) - P2B(br["S"]), g("strut_upper"), "constraint", note="2-link side brace, lower link with the knee: mount on the strut; meets brace_upper at the knee", target={"knee_m": list(P2B(br["K"])), "pairs_with": g("brace_upper")})
    aT, aB = [x + sx * 230, yp - 560, CEIL], [x + sx * 140, yp - 40, PIVZ - 330]
    set_joint(g("actuator_body"), P2B(aT), P2B(aB) - P2B(aT), g("top_block"), "constraint", note="Damped Track (Z) to TGT_" + g("actuator_rod"), target={"aims_at_m": list(P2B(aB))})
    set_joint(g("actuator_rod"), P2B(aB), P2B(aT) - P2B(aB), g("strut_upper"), "constraint", note="Damped Track (Z) to TGT_" + g("actuator_body"), target={"aims_at_m": list(P2B(aT))})
    for kind, hx in (("inner", 1160), ("outer", 2040)):
        dj = doors_json[f"door {kind} {'front' if c[0] == 'F' else 'rear'} {'+X' if sx > 0 else '-X'}"]
        nm = g("door_in" if kind == "inner" else "door_out")
        set_joint(nm, P2B([sx * hx, yp, 2040]), A2B(dj["axis"]), "HULL_body.R", "hinge", dj["stowedDeg"] - dj["deployedDeg"], 4, "bay door closes")
for r in recs:
    n = r["name"]
    if n.startswith("HULL_bay_liner") or n.startswith("HULL_shaft"): JOINT.setdefault(n, {"F": None, "parent": "HULL_body.R", "motion": "fixed"})
JOINT["HULL_body.L"] = {"F": None, "parent": "HULL_body.R", "motion": "fixed"}
# lift: housing (fixed) -> s1 -> s2 -> s3; platform on the FR ram's s3; the other rams copy FR by drivers
STAGE_STOW = {1: 0.680, 2: 0.670, 3: 0.690}
for c in ["FL", "FR", "RL", "RR"]:
    sx = 1 if c[1] == "R" else -1; y = 3810 if c[0] == "F" else 1790; x = sx * 560
    set_joint(f"LIFT_housing_{c}", P2B([x, y, 2210]), Vector((0, 0, 1)), "HULL_body.R", "fixed")
    tops = {1: 2230, 2: 1550, 3: 870}
    prev = f"LIFT_housing_{c}"
    for k in (1, 2, 3):
        set_joint(f"LIFT_ram_{c}_s{k}", P2B([x, y, tops[k]]), Vector((0, 0, 1)), prev, "slide", STAGE_STOW[k], 5, f"ram stage {k} retracts into {'the housing' if k == 1 else 'stage ' + str(k - 1)}" + ("" if c == "FR" else " (driver copies LIFT_ram_FR)"))
        prev = f"LIFT_ram_{c}_s{k}"
set_joint("LIFT_platform", P2B([0, 2800, 0]), Vector((0, 0, 1)), "LIFT_ram_FR_s3", "fixed", note="rides on the FR ram; raised it closes the hatch flush at Z 2.04")
for r in recs:
    n = r["name"]
    if n.startswith(("LIFT_rib", "LIFT_edge_light", "LIFT_rail")): JOINT[n] = {"F": None, "parent": "LIFT_platform", "motion": "fixed"}
# gyro: outer gimbal (hinge X in the trunnions) -> inner gimbal -> rotor (spin) with rim light, core, spokes
GC = gyro["centre"]
set_joint("GYRO_outer_gimbal", P2B(GC), A2B(gyro["parts"]["rc11_Gyro_OuterGimbal"]["axis"]), "HULL_body.R", "hinge", note="gimbal pitch in the trunnions")
set_joint("GYRO_inner_gimbal", P2B(GC), A2B(gyro["parts"]["rc11_Gyro_InnerGimbal"]["axis"]), "GYRO_outer_gimbal", "hinge", note="gimbal roll, child of the outer")
set_joint("GYRO_rotor", P2B(GC), A2B(gyro["parts"]["rc11_Gyro_Rotor"]["axis"]), "GYRO_inner_gimbal", "spin", note="rotor spin; rim light, core and spokes ride on it")
for r in recs:
    n = r["name"]
    if n in ("GYRO_rim_light", "GYRO_core") or n.startswith("GYRO_spoke"): JOINT[n] = {"F": None, "parent": "GYRO_rotor", "motion": "fixed"}
    elif n.startswith(("GYRO_trunnion", "GYRO_base_bolt")) or n.startswith("DETAIL_"): JOINT.setdefault(n, {"F": None, "parent": "HULL_body.R", "motion": "fixed"})

# parent with a zero rest pose: world = parent @ parent_inverse @ basis, basis = identity
def parent_to(child, parent):
    co, po = bpy.data.objects[child], bpy.data.objects[parent]
    W = co.matrix_world.copy()
    co.parent = po; co.matrix_parent_inverse = po.matrix_world.inverted() @ W; co.matrix_basis = Matrix.Identity(4)
order = sorted(JOINT, key=lambda n: (n.count("_s") and 0, n))
done = set()
def resolve_(n):
    if n in done or n not in JOINT: return
    p = JOINT[n]["parent"]
    if p and p in JOINT: resolve_(p)
    if p: parent_to(n, p)
    done.add(n)
for n in JOINT: resolve_(n)
# pivots and constraint targets
def empty(name, F, parent, size=0.15, kind="ARROWS"):
    e = bpy.data.objects.new(name, None); e.empty_display_type = kind; e.empty_display_size = size
    COL["RIG_PIVOTS"].objects.link(e); e.matrix_world = F
    po = bpy.data.objects[parent]; e.parent = po; e.matrix_parent_inverse = po.matrix_world.inverted() @ F; e.matrix_basis = Matrix.Identity(4)
    return e
for n, j in JOINT.items():
    if j["F"] is not None and j["motion"] != "fixed" or (j["F"] is not None and n.startswith(("GEAR", "LIFT_housing", "LIFT_platform"))):
        empty("PIV_" + n, j["F"], n)
for c in ["FL", "FR", "RL", "RR"]:
    # each target sits at the other part's mount, parented to that mount's carrier (no dependency cycle)
    for a, b, carrier in (("actuator_body", "actuator_rod", "strut_upper"), ("actuator_rod", "actuator_body", "top_block")):
        tgt = empty(f"TGT_GEAR_{c}_{b}", JOINT[f"GEAR_{c}_{b}"]["F"], f"GEAR_{c}_{carrier}", 0.06, "SPHERE")
        con = bpy.data.objects[f"GEAR_{c}_{a}"].constraints.new("DAMPED_TRACK"); con.target = tgt; con.track_axis = "TRACK_Z"
    BRACE[c]["knee_tgt"] = empty(f"TGT_GEAR_{c}_brace_knee", frame(P2B(BRACE[c]["K"]), Vector((1, 0, 0))), f"GEAR_{c}_brace_lower", 0.06, "SPHERE")
# lift drivers: the other rams copy the FR ram stage slides
for c in ["FL", "RL", "RR"]:
    for k in (1, 2, 3):
        d = bpy.data.objects[f"LIFT_ram_{c}_s{k}"].driver_add("location", 2).driver; d.type = "SUM"
        v = d.variables.new(); v.type = "SINGLE_PROP"; v.targets[0].id = bpy.data.objects[f"LIFT_ram_FR_s{k}"]; v.targets[0].data_path = "location[2]"

# ---------------------------------------------------------------- scale ref, render setup
lc = bpy.context.view_layer.layer_collection.children["SCALE_REF"]; COL["SCALE_REF"].hide_render = True; lc.hide_viewport = True
for o in bpy.data.objects:
    if o.type == "MESH": o.data.update()
bpy.context.view_layer.update()
def tris(o): o.data.calc_loop_triangles(); return len(o.data.loop_triangles)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
ship = [o for o in meshes if o.users_collection[0].name != "SCALE_REF"]
pts = [o.matrix_world @ Vector(c) for o in ship for c in o.bound_box]
size = {"min_m": [round(min(p[i] for p in pts), 4) for i in range(3)], "max_m": [round(max(p[i] for p in pts), 4) for i in range(3)]}
TRIS = {o.name: tris(o) for o in meshes}

scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"; scene.display.shading.color_type = "MATERIAL"; scene.display.shading.show_cavity = True
scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
world = bpy.data.worlds.new("w"); scene.world = world; world.color = (0.18, 0.19, 0.21)
cam = bpy.data.objects.new("CHECK_cam", bpy.data.cameras.new("CHECK_cam")); scene.collection.objects.link(cam); scene.camera = cam
cam.data.lens = 32
def aim(loc, tgt):
    cam.location = loc; cam.rotation_mode = "QUATERNION"; cam.rotation_quaternion = (Vector(tgt) - Vector(loc)).to_track_quat("-Z", "Y")
def render(name):
    scene.render.filepath = os.path.join(HERE, name); bpy.ops.render.render(write_still=True)
ground = bpy.data.objects.new("CHECK_ground", None)

# ---------------------------------------------------------------- save, export
cam_low = ((9.0, -11.5, 0.35), (0.0, -0.8, 1.9))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "neoRC11_rigready.blend"), compress=True)
bpy.ops.object.select_all(action="DESELECT")
for o in ship: o.select_set(True)
for o in COL["RIG_PIVOTS"].objects: o.select_set(False)
bpy.ops.export_scene.gltf(filepath=os.path.join(HERE, "neoRC11_rigready.glb"), export_format="GLB", use_selection=True, export_apply=True,
                          export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6)
bpy.ops.object.select_all(action="DESELECT")
lc.hide_viewport = False
for o in COL["SCALE_REF"].objects: o.select_set(True)
bpy.ops.export_scene.gltf(filepath=os.path.join(HERE, "scale_ref.glb"), export_format="GLB", use_selection=True)
lc.hide_viewport = True

# ---------------------------------------------------------------- pose test: deployed, front, stowed
aim(*cam_low); render("check-deployed.png")
aim((0.0, -24.0, 3.2), (0.0, 0.0, 3.0)); render("check-front.png")
def pose(stowed):
    for n, j in JOINT.items():
        o = bpy.data.objects[n]; o.rotation_mode = "XYZ"
        if j["motion"] == "hinge" and j.get("order"): o.rotation_euler = (0, 0, math.radians(j["stowed"]) if stowed else 0)
        elif j["motion"] == "slide" and not o.animation_data: o.location = (0, 0, j["stowed"] if stowed else 0)
    bpy.context.view_layer.update()
def wb(o):
    dg = bpy.context.evaluated_depsgraph_get(); oe = o.evaluated_get(dg)
    vs = [oe.matrix_world @ v.co for v in oe.data.vertices]
    return [min(v[i] for v in vs) for i in range(3)], [max(v[i] for v in vs) for i in range(3)]
pose(True)
checks = {"legs": {}, "doors": {}, "lift": {}}
for c in ["FL", "FR", "RL", "RR"]:
    sx = 1 if c[1] == "R" else -1; yp = FRONT if c[0] == "F" else REAR
    los, his = zip(*[wb(bpy.data.objects[f"GEAR_{c}_{p}"]) for p in ("strut_upper", "stage_mid", "slider", "fork", "knuckle", "foot")])
    lo = [min(v[i] for v in los) for i in range(3)]; hi = [max(v[i] for v in his) for i in range(3)]
    # bay box in blender space
    bx = sorted([-sx * 1.160, -sx * 2.040]); by = sorted([-(yp - 1790) / 1000, -(yp + 150) / 1000])
    clr = {"x_mm": round(min(lo[0] - bx[0], bx[1] - hi[0]) * 1000), "y_mm": round(min(lo[1] - by[0], by[1] - hi[1]) * 1000),
           "above_closed_doors_mm": round((lo[2] - 2.058) * 1000), "below_bay_ceiling_mm": round((2.4295 - hi[2]) * 1000)}
    checks["legs"][c] = {**clr, "fits": all(v >= 20 for v in clr.values())}
    for d in ("door_in", "door_out"):
        lo_, hi_ = wb(bpy.data.objects[f"GEAR_{c}_{d}"])
        checks["doors"][f"{c}_{d}"] = {"bottom_z_m": round(lo_[2], 4), "top_z_m": round(hi_[2], 4), "flush": abs(lo_[2] - 2.040) < 0.001 and hi_[2] - lo_[2] < 0.025}
plo, phi = wb(bpy.data.objects["LIFT_platform"]); rlo, rhi = zip(*[wb(bpy.data.objects[f"LIFT_rail{s}"]) for s in (".L", ".R")])
checks["lift"] = {"platform_bottom_z_m": round(plo[2], 4), "flush": abs(plo[2] - 2.040) < 0.001, "rail_top_z_m": round(max(h[2] for h in rhi), 4), "rail_clear_to_shaft_ceiling_mm": round((4.290 - max(h[2] for h in rhi)) * 1000),
                  "ram_tops_m": {c: round(wb(bpy.data.objects[f"LIFT_ram_{c}_s1"])[1][2], 4) for c in ["FL", "FR", "RL", "RR"]}, "housing_top_m": 3.5}
aim(*cam_low); render("check-stowed.png")
pose(False)

# ---------------------------------------------------------------- manifest
def entry(o):
    r = OB.get(o.name, {}); j = JOINT.get(o.name, {})
    F = j.get("F")
    e = {"name": o.name, "collection": o.users_collection[0].name, "parent": o.parent.name if o.parent else None,
         "material": o.data.materials[0].name if o.data.materials else None, "triangles": TRIS[o.name],
         "plasticity_body_id": r.get("src"), "plasticity_instance_id": r.get("inst"), "mirrored_copy": r.get("mirrored", False),
         "motion": j.get("motion", "fixed")}
    if F is not None:
        e["pivot_m"] = [round(v, 5) for v in F.translation]; e["axis"] = [round(v, 6) for v in F.col[2][:3]]
        e["pivot_plasticity_mm"] = B2P(F.translation)
    if e["motion"] in ("hinge", "slide", "spin"):
        e["channel"] = "rotation_euler.z (deg)" if e["motion"] in ("hinge", "spin") else "location.z (m)"
        e["deployed"] = 0.0; e["stowed"] = j.get("stowed", 0.0); e["stow_step"] = j.get("order")
    if j.get("note"): e["note"] = j["note"]
    if j.get("target"): e["constraint_targets"] = j["target"]
    return e
manifest = {
    "units": "metres", "up": "Z", "nose": "-Y", "ship_left": "+X (.L)", "ground_z": 0.0, "belly_z": 2.04, "lowest_ship_z": 1.968, "roof_z": 5.2934,
    "from_plasticity": "(x, y, z)_m = (-x, -y, z)_mm * 0.001", "rest_pose": "deployed (landed, doors open, lift down); every joint's local transform is zero at rest",
    "overall_bounds_m": size, "blender": bpy.app.version_string,
    "stow_order": ["1 telescope closes (stage_mid +0.570 m, slider +0.230 m along local Z)", "2 leg hinge strut_upper -90 deg about local Z", "3 foot +90 deg about the knuckle", "4 doors close (door_in/door_out to 0 deg from open)", "lift (independent): LIFT_ram_FR_s1/s2/s3 slide +0.680/+0.670/+0.690 m (total 2.040 m, platform flush with the belly); other rams follow by drivers"],
    "gyro": {"centre_m": list(P2B(GC)), "animation": gyro.get("animation"), "rest_note": "outer tilted 18 deg, inner 22 deg at rest (already in the mesh)"},
    "pose_check_stowed": checks,
    "objects": [entry(o) for o in sorted(meshes, key=lambda o: o.name)],
    "pivots": [{"name": e.name, "parent": e.parent.name if e.parent else None, "location_m": [round(v, 5) for v in e.matrix_world.translation], "z_axis": [round(v, 6) for v in e.matrix_world.col[2][:3]]} for e in COL["RIG_PIVOTS"].objects],
    "decimated": {"rule": [f"{p} x{q}" for p, q in DECIMATE], "objects": len(decimated), "note": "smooth by angle 30 deg after decimation; all other objects keep the CAD normals from the OBJ"},
    "totals": {"mesh_objects": len(ship), "triangles": sum(TRIS[o.name] for o in ship), "scale_ref_triangles": sum(TRIS[o.name] for o in meshes if o not in ship)},
}
json.dump(manifest, open(os.path.join(HERE, "rig_manifest.json"), "w"), indent=1)
print("RIG_DONE", json.dumps({"totals": manifest["totals"], "checks": checks, "size": size}))
