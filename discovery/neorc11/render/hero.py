# Hero render of the neoRC 11 hover car (Blender 5.2, headless).
#   /Applications/Blender.app/Contents/MacOS/Blender -b -P discovery/neorc11/render/hero.py -- [--preview]
# Imports neorc11_render.obj (millimetres, Z up, nose +Y) at 0.001 scale, assigns materials by body name, builds a
# dark glossy floor, a big soft key, a cool rim, cyan light pools under the drive and pods, renders with Cycles
# (Metal GPU when available) and saves neorc11_hero.blend next to this script.
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
PREVIEW = "--preview" in ARGS

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ---- geometry
bpy.ops.wm.obj_import(filepath=os.path.join(HERE, "neorc11_render.obj"), global_scale=0.001, forward_axis="Y", up_axis="Z")
ship = [o for o in scene.objects if o.type == "MESH"]
for o in ship:
    for poly in o.data.polygons:
        poly.use_smooth = True


def principled(name, base, metallic=0.0, rough=0.4, coat=0.0, coat_rough=0.03, emit=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*base, 1)
    p.inputs["Metallic"].default_value = metallic
    p.inputs["Roughness"].default_value = rough
    p.inputs["Coat Weight"].default_value = coat
    p.inputs["Coat Roughness"].default_value = coat_rough
    if emit:
        p.inputs["Emission Color"].default_value = (*emit, 1)
        p.inputs["Emission Strength"].default_value = strength
    return m


MAT = {
    "paint": principled("Eldorado midnight", (0.012, 0.022, 0.06), metallic=0.65, rough=0.32, coat=1.0, coat_rough=0.02),
    "chrome": principled("Chrome", (0.92, 0.93, 0.95), metallic=1.0, rough=0.05),
    "gunmetal": principled("Gunmetal", (0.07, 0.075, 0.085), metallic=1.0, rough=0.33),
    "visor": principled("Smoked visor", (0.004, 0.006, 0.01), rough=0.02, coat=1.0),
    "sensor": principled("Sensor glass", (0.003, 0.003, 0.004), rough=0.03, coat=1.0),
    "core": principled("Repulsor core", (0.05, 0.6, 1.0), emit=(0.35, 0.9, 1.0), strength=18.0),
    "ring": principled("Emitter ring", (0.6, 0.8, 0.9), metallic=0.8, rough=0.2, emit=(0.55, 0.92, 1.0), strength=4.0),
    "pad": principled("Hover pad", (0.05, 0.6, 1.0), emit=(0.3, 0.85, 1.0), strength=9.0),
    "head": principled("Headlight", (1, 0.95, 0.85), emit=(1.0, 0.9, 0.75), strength=40.0),
    "tail": principled("Taillight", (1, 0.02, 0.02), emit=(1.0, 0.03, 0.02), strength=25.0),
}
RULES = [  # first matching prefix wins
    ("rc11_hull", "paint"), ("rc11_trim", "chrome"), ("rc11_sill", "chrome"), ("rc11_grille_bar", "chrome"),
    ("rc11_louvre", "gunmetal"), ("rc11_drive_vane", "gunmetal"), ("rc11_exhaust_vane", "gunmetal"),
    ("rc11_Visor", "visor"), ("rc11_nose_strip", "sensor"), ("rc11_drive_core", "core"), ("rc11_exhaust_glow", "core"),
    ("rc11_drive_ring", "ring"), ("rc11_hover_pad", "pad"), ("rc11_headlight", "head"), ("rc11_taillight", "tail"),
]
unmatched = []
for o in ship:
    key = next((k for prefix, k in RULES if o.name.startswith(prefix)), None)
    if key is None:
        unmatched.append(o.name)
        key = "paint"
    o.data.materials.clear()
    o.data.materials.append(MAT[key])
    if key == "visor":  # the visor sheet lies on the hull surface: give it 3 mm of thickness each way
        sol = o.modifiers.new("lift", "SOLIDIFY")
        sol.thickness = 0.006
        sol.offset = 0.0
print("unmatched objects:", unmatched)

lo = Vector((min(v[i] for o in ship for v in (o.matrix_world @ Vector(c) for c in o.bound_box)) for i in range(3)))
hi = Vector((max(v[i] for o in ship for v in (o.matrix_world @ Vector(c) for c in o.bound_box)) for i in range(3)))
print("ship bounds m:", tuple(round(x, 3) for x in lo), tuple(round(x, 3) for x in hi))

# ---- floor: dark wet concrete (roughness varied by noise)
bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, 0))
floor = bpy.context.object
fm = bpy.data.materials.new("Wet floor")
fm.use_nodes = True
nt = fm.node_tree
p = nt.nodes["Principled BSDF"]
p.inputs["Base Color"].default_value = (0.018, 0.019, 0.021, 1)
noise = nt.nodes.new("ShaderNodeTexNoise")
noise.inputs["Scale"].default_value = 0.35
noise.inputs["Detail"].default_value = 6.0
ramp = nt.nodes.new("ShaderNodeMapRange")
ramp.inputs["To Min"].default_value = 0.04
ramp.inputs["To Max"].default_value = 0.38
nt.links.new(noise.outputs["Fac"], ramp.inputs["Value"])
nt.links.new(ramp.outputs["Result"], p.inputs["Roughness"])
floor.data.materials.append(fm)

# ---- world: very dark blue, a hint of ambient
world = bpy.data.worlds.new("Dusk")
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.006, 0.009, 0.016, 1)
bg.inputs["Strength"].default_value = 1.0
scene.world = world


def area(name, loc, target, size, power, color, shape="SQUARE", size_y=None):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = power
    data.color = color
    data.shape = shape
    data.size = size
    if size_y is not None:
        data.size_y = size_y
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    return obj


centre = (lo + hi) / 2
area("Key", (-10.0, 14.0, 6.5), centre, 8.0, 30000, (1.0, 0.96, 0.9))
area("Rim", (11.0, -13.0, 7.0), centre, 5.0, 14000, (0.75, 0.85, 1.0))
area("Top fill", (0.0, 0.0, 16.0), centre, 14.0, 2500, (0.8, 0.86, 1.0))
# Cyan light pools on the floor under the repulsion drive and both pods (the emitters' throw).
area("Drive pool", (0, -0.5, 1.15), (0, -0.5, 0), 1.6, 260, (0.35, 0.85, 1.0), shape="RECTANGLE", size_y=3.8)
for x in (2.6, -2.6):
    area(f"Pod pool {x:+.1f}", (x, 0.0, 1.18), (x, 0.0, 0), 0.5, 280, (0.35, 0.85, 1.0), shape="RECTANGLE", size_y=12.5)

# ---- camera: low 3/4 front-left hero angle
cam_data = bpy.data.cameras.new("Hero")
cam_data.lens = 45
cam_data.dof.use_dof = True
cam_data.dof.aperture_fstop = 8.0
cam = bpy.data.objects.new("Hero", cam_data)
scene.collection.objects.link(cam)
cam.location = (-8.5, 20.5, 1.05)
aim = Vector((0.2, 1.2, 2.35))
cam.rotation_euler = (aim - cam.location).to_track_quat("-Z", "Y").to_euler()
cam_data.dof.focus_distance = (Vector((-3.0, 6.5, 2.2)) - cam.location).length
scene.camera = cam

# ---- render
scene.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
try:
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
    scene.cycles.device = "GPU"
except Exception as error:  # CPU fallback
    print("GPU setup failed:", error)
cs = scene.cycles
cs.samples = 48 if PREVIEW else 256
cs.use_denoising = True
cs.max_bounces = 6
cs.caustics_reflective = False
cs.caustics_refractive = False
scene.render.resolution_x, scene.render.resolution_y = (960, 540) if PREVIEW else (3840, 2160)
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = "AgX"
for look in ("AgX - Punchy", "AgX - High Contrast", "Punchy"):
    try:
        scene.view_settings.look = look
        break
    except TypeError:
        continue
scene.view_settings.exposure = 0.4
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_depth = "16" if not PREVIEW else "8"

out = os.path.join(HERE, "hero_preview.png" if PREVIEW else "hero_4k.png")
scene.render.filepath = out
if not PREVIEW:
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "neorc11_hero.blend"))
bpy.ops.render.render(write_still=True)
print("wrote", out)
