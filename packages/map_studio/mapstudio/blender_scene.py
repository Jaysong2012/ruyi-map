"""Blender backend entry point. Scene construction remains project-agnostic."""
import json, math, sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector


args = sys.argv[sys.argv.index("--") + 1:]
scene_path, shot_id = Path(args[0]).resolve(), args[1]
spec = json.loads(scene_path.read_text(encoding="utf-8"))
shot = next((x for x in spec["shots"] if x["id"] == shot_id), None)
if not shot:
    raise SystemExit(f"unknown shot: {shot_id}")

# The backend intentionally refuses to invent missing prepared terrain.
manifest = scene_path.parent / spec["output"]["directory"] / "prepared/manifest.json"
if not manifest.exists():
    raise SystemExit("prepared manifest missing; run mapstudio prepare first")

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = spec["output"]["width"]
scene.render.resolution_y = spec["output"]["height"]
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.film_transparent = False
scene.view_settings.look = "AgX - Medium High Contrast"

prepared = manifest.parent
data = json.loads(manifest.read_text(encoding="utf-8"))
height = np.load(prepared / data["height"])
rows, cols = height.shape
west, south, east, north = data["bounds"]
lat_c = (south + north) / 2
span_x = (east-west) * 111.3 * math.cos(math.radians(lat_c))
span_y = (north-south) * 110.6
look_path = Path(__file__).resolve().parents[1] / "presets" / f"{spec['look']['preset']}.json"
look = json.loads(look_path.read_text(encoding="utf-8"))
# 项目级调参不动全局 preset：spec.look.overrides 深合并覆盖
def _merge(a, b):
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(a.get(k), dict): _merge(a[k], v)
        else: a[k] = v
_merge(look, spec["look"].get("overrides", {}))
render=look.get("render",{}); scene.render.engine=render.get("engine","BLENDER_EEVEE")
if scene.render.engine == "CYCLES":
    scene.cycles.samples=int(render.get("samples",32)); scene.cycles.use_denoising=bool(render.get("denoise",True))
exag = look["terrain"]["verticalExaggeration"]
material_look = look.get("material", {})

def rgba(name, fallback):
    value = material_look.get(name, fallback)
    return (*value[:3], value[3] if len(value) > 3 else 1)
z0 = float(np.nanmin(height))
z = (height-z0)/1000*exag

verts = [(c/(cols-1)*span_x-span_x/2, span_y/2-r/(rows-1)*span_y, float(z[r,c]))
         for r in range(rows) for c in range(cols)]
faces = [(r*cols+c, r*cols+c+1, (r+1)*cols+c+1, (r+1)*cols+c)
         for r in range(rows-1) for c in range(cols-1)]
mesh = bpy.data.meshes.new("terrain")
mesh.from_pydata(verts, [], faces); mesh.update()
terrain = bpy.data.objects.new("terrain", mesh); bpy.context.collection.objects.link(terrain)
for poly in mesh.polygons:
    poly.use_smooth = True
uv = mesh.uv_layers.new(name="geo").data
for poly in mesh.polygons:
    for li in poly.loop_indices:
        vi = mesh.loops[li].vertex_index; r, c = divmod(vi, cols)
        uv[li].uv = (c/(cols-1), 1-r/(rows-1))

mat = bpy.data.materials.new("verdant terrain"); mat.use_nodes = True
n = mat.node_tree.nodes; links = mat.node_tree.links; n.clear()
out = n.new("ShaderNodeOutputMaterial"); bsdf = n.new("ShaderNodeBsdfPrincipled")
tex = n.new("ShaderNodeTexImage"); tex.image = bpy.data.images.load(str(prepared / data.get("albedo",data["texture"]))); tex.interpolation = "Linear"
normal = n.new("ShaderNodeNewGeometry"); sep = n.new("ShaderNodeSeparateXYZ")
slope = n.new("ShaderNodeMapRange"); slope.interpolation_type="SMOOTHSTEP"; slope.inputs["From Min"].default_value=look["material"].get("rockSlopeFull",.74); slope.inputs["From Max"].default_value=look["material"].get("rockSlopeStart",.48); slope.clamp=True
coord=n.new("ShaderNodeTexCoord"); mapping=n.new("ShaderNodeMapping"); mapping.inputs["Scale"].default_value=(1.2,1.2,look["material"].get("graniteJointScale",7.5))
joint=n.new("ShaderNodeTexNoise"); joint.noise_dimensions="3D"; joint.inputs["Scale"].default_value=2.1; joint.inputs["Detail"].default_value=5.0; joint.inputs["Roughness"].default_value=.72
elevation_sep=n.new("ShaderNodeSeparateXYZ"); elevation=n.new("ShaderNodeMapRange"); elevation.interpolation_type="SMOOTHSTEP"; elevation.inputs["From Min"].default_value=0; elevation.inputs["From Max"].default_value=max(.001,float(np.max(z))); elevation.clamp=True
forest=n.new("ShaderNodeValToRGB"); ramp=forest.color_ramp; ramp.elements.remove(ramp.elements[1]);
for position,color in material_look.get("elevationRamp",[[0.0,[.018,.07,.055,1]],[.42,[.035,.16,.08,1]],[.72,[.10,.30,.15,1]],[1.0,[.30,.40,.27,1]]]):
    element=ramp.elements[0] if position==0 else ramp.elements.new(position); element.position=position; element.color=tuple(color)
granite=n.new("ShaderNodeValToRGB"); granite.color_ramp.elements[0].position=.28; granite.color_ramp.elements[0].color=rgba("rockShadow",(.11,.105,.095,1)); granite.color_ramp.elements[1].position=.72; granite.color_ramp.elements[1].color=rgba("rockLight",(.27,.245,.215,1))
tex_bw=n.new("ShaderNodeRGBToBW")
sat_grade=n.new("ShaderNodeHueSaturation"); sat_grade.inputs["Hue"].default_value=material_look.get("textureHue",.5); sat_grade.inputs["Saturation"].default_value=material_look.get("textureSaturation",1.0); sat_grade.inputs["Value"].default_value=material_look.get("textureValue",1.0)
sat_mix=n.new("ShaderNodeMixRGB"); sat_mix.blend_type="MIX"; sat_mix.inputs[0].default_value=material_look.get("terrainTintStrength",.22)
rock_mix=n.new("ShaderNodeMixRGB"); rock_mix.blend_type="MIX"
rock_factor=n.new("ShaderNodeMath"); rock_factor.operation="MULTIPLY"; rock_factor.inputs[1].default_value=material_look.get("rockStrength",.32)
depth_add=n.new("ShaderNodeMath"); depth_add.operation="ADD"
depth_sep=n.new("ShaderNodeSeparateXYZ")
depth_range=n.new("ShaderNodeMapRange"); depth_range.interpolation_type="SMOOTHSTEP"; depth_range.inputs["From Min"].default_value=.62; depth_range.inputs["From Max"].default_value=1.52; depth_range.inputs["To Max"].default_value=material_look.get("distanceTintStrength",.48); depth_range.clamp=True
depth_mix=n.new("ShaderNodeMixRGB"); depth_mix.blend_type="MIX"; depth_mix.inputs[2].default_value=rgba("distanceTint",(.16,.28,.32,1))
ambient=n.new("ShaderNodeAmbientOcclusion"); ambient.inputs["Distance"].default_value=material_look.get("aoDistance",.45); ambient.samples=16
ao_mix=n.new("ShaderNodeMixRGB"); ao_mix.blend_type="MULTIPLY"; ao_mix.inputs[0].default_value=material_look.get("aoStrength",.42)
rough_map=n.new("ShaderNodeMapRange"); rough_map.inputs["From Min"].default_value=.08; rough_map.inputs["From Max"].default_value=.92; rough_map.inputs["To Min"].default_value=.96; rough_map.inputs["To Max"].default_value=.58; rough_map.clamp=True
links.new(normal.outputs["Normal"],sep.inputs[0]); links.new(sep.outputs["Z"],slope.inputs["Value"])
links.new(normal.outputs["Position"],elevation_sep.inputs[0]); links.new(elevation_sep.outputs["Z"],elevation.inputs["Value"]); links.new(elevation.outputs["Result"],forest.inputs[0])
links.new(coord.outputs["Generated"],mapping.inputs["Vector"]); links.new(mapping.outputs["Vector"],joint.inputs["Vector"]); links.new(joint.outputs["Fac"],granite.inputs[0])
links.new(tex.outputs["Color"],tex_bw.inputs[0]); links.new(tex_bw.outputs[0],rough_map.inputs["Value"]); links.new(rough_map.outputs["Result"],bsdf.inputs["Roughness"]); links.new(tex.outputs["Color"],sat_grade.inputs["Color"]); links.new(sat_grade.outputs["Color"],sat_mix.inputs[1]); links.new(forest.outputs["Color"],sat_mix.inputs[2]); links.new(sat_mix.outputs[0],rock_mix.inputs[1]); links.new(granite.outputs["Color"],rock_mix.inputs[2]); links.new(slope.outputs["Result"],rock_factor.inputs[0]); links.new(rock_factor.outputs[0],rock_mix.inputs[0])
links.new(coord.outputs["Generated"],depth_sep.inputs[0]); links.new(depth_sep.outputs["X"],depth_add.inputs[0]); links.new(depth_sep.outputs["Y"],depth_add.inputs[1]); links.new(depth_add.outputs[0],depth_range.inputs["Value"]); links.new(depth_range.outputs["Result"],depth_mix.inputs[0]); links.new(rock_mix.outputs[0],depth_mix.inputs[1])
if data.get("masks",{}).get("rock"):
    rock_mask=n.new("ShaderNodeTexImage"); rock_mask.image=bpy.data.images.load(str(prepared/data["masks"]["rock"])); rock_mask.image.colorspace_settings.name="Non-Color"; rock_mask.interpolation="Linear"
    links.new(rock_mask.outputs["Color"],rock_factor.inputs[0])
surface_color=depth_mix.outputs[0]
if data.get("masks",{}).get("hillshade"):
    hill_tex=n.new("ShaderNodeTexImage"); hill_tex.image=bpy.data.images.load(str(prepared/data["masks"]["hillshade"])); hill_tex.image.colorspace_settings.name="Non-Color"; hill_tex.interpolation="Linear"
    hill_mix=n.new("ShaderNodeMixRGB"); hill_mix.blend_type="SOFT_LIGHT"; hill_mix.inputs[0].default_value=material_look.get("hillshadeStrength",.42)
    links.new(surface_color,hill_mix.inputs[1]); links.new(hill_tex.outputs["Color"],hill_mix.inputs[2]); surface_color=hill_mix.outputs[0]
if material_look.get("valleyTintStrength",0)>0 and data.get("masks",{}).get("valley"):
    valley_tex=n.new("ShaderNodeTexImage"); valley_tex.image=bpy.data.images.load(str(prepared/data["masks"]["valley"])); valley_tex.image.colorspace_settings.name="Non-Color"; valley_tex.interpolation="Linear"
    valley_factor=n.new("ShaderNodeMath"); valley_factor.operation="MULTIPLY"; valley_factor.inputs[1].default_value=material_look.get("valleyTintStrength",.20)
    valley_mix=n.new("ShaderNodeMixRGB"); valley_mix.blend_type="MIX"; valley_mix.inputs[2].default_value=rgba("valleyTint",(.025,.20,.22,1))
    valley_roughness=n.new("ShaderNodeMath"); valley_roughness.operation="MULTIPLY"; valley_roughness.inputs[1].default_value=material_look.get("valleyRoughnessDrop",.32)
    final_roughness=n.new("ShaderNodeMath"); final_roughness.operation="SUBTRACT"; final_roughness.use_clamp=True
    links.new(valley_tex.outputs["Color"],valley_factor.inputs[0]); links.new(valley_factor.outputs[0],valley_mix.inputs[0]); links.new(surface_color,valley_mix.inputs[1]); links.new(valley_tex.outputs["Color"],valley_roughness.inputs[0]); links.new(rough_map.outputs["Result"],final_roughness.inputs[0]); links.new(valley_roughness.outputs[0],final_roughness.inputs[1]); links.new(final_roughness.outputs[0],bsdf.inputs["Roughness"]); surface_color=valley_mix.outputs[0]
links.new(surface_color,ao_mix.inputs[1]); links.new(ambient.outputs["Color"],ao_mix.inputs[2]); links.new(ao_mix.outputs[0],bsdf.inputs["Base Color"])
edge_fade=float(look["terrain"].get("edgeFade",0))
if edge_fade>0:
    edge_sep=n.new("ShaderNodeSeparateXYZ"); x_center=n.new("ShaderNodeMath"); x_center.operation="SUBTRACT"; x_center.inputs[1].default_value=.5
    y_center=n.new("ShaderNodeMath"); y_center.operation="SUBTRACT"; y_center.inputs[1].default_value=.5
    x_abs=n.new("ShaderNodeMath"); x_abs.operation="ABSOLUTE"; y_abs=n.new("ShaderNodeMath"); y_abs.operation="ABSOLUTE"
    edge_max=n.new("ShaderNodeMath"); edge_max.operation="MAXIMUM"; edge_map=n.new("ShaderNodeMapRange"); edge_map.interpolation_type="SMOOTHSTEP"; edge_map.inputs["From Min"].default_value=.5-edge_fade; edge_map.inputs["From Max"].default_value=.5; edge_map.inputs["To Min"].default_value=1; edge_map.inputs["To Max"].default_value=0; edge_map.clamp=True
    transparent=n.new("ShaderNodeBsdfTransparent"); shader_mix=n.new("ShaderNodeMixShader")
    links.new(coord.outputs["Generated"],edge_sep.inputs[0]); links.new(edge_sep.outputs["X"],x_center.inputs[0]); links.new(edge_sep.outputs["Y"],y_center.inputs[0]); links.new(x_center.outputs[0],x_abs.inputs[0]); links.new(y_center.outputs[0],y_abs.inputs[0]); links.new(x_abs.outputs[0],edge_max.inputs[0]); links.new(y_abs.outputs[0],edge_max.inputs[1]); links.new(edge_max.outputs[0],edge_map.inputs["Value"]); links.new(edge_map.outputs["Result"],shader_mix.inputs[0]); links.new(transparent.outputs[0],shader_mix.inputs[1]); links.new(bsdf.outputs[0],shader_mix.inputs[2]); links.new(shader_mix.outputs[0],out.inputs[0])
else:
    links.new(bsdf.outputs[0],out.inputs[0])
canopy=n.new("ShaderNodeTexNoise"); canopy.inputs["Scale"].default_value=46; canopy.inputs["Detail"].default_value=3.5; canopy.inputs["Roughness"].default_value=.72
forest_mask=n.new("ShaderNodeMath"); forest_mask.operation="SUBTRACT"; forest_mask.inputs[0].default_value=1
canopy_height=n.new("ShaderNodeMath"); canopy_height.operation="MULTIPLY"
bump=n.new("ShaderNodeBump"); bump.inputs["Strength"].default_value=.22; bump.inputs["Distance"].default_value=.032
links.new(coord.outputs["Generated"],canopy.inputs["Vector"]); links.new(slope.outputs["Result"],forest_mask.inputs[1]); links.new(tex_bw.outputs[0],canopy_height.inputs[0]); links.new(forest_mask.outputs[0],canopy_height.inputs[1]); links.new(canopy_height.outputs[0],bump.inputs["Height"]); links.new(bump.outputs["Normal"],bsdf.inputs["Normal"])
pbr=look.get("pbr",{}).get("rock",{}); package_root=Path(__file__).resolve().parents[1]
diffuse_path=package_root/pbr.get("diffuse",""); normal_path=package_root/pbr.get("normal",""); rough_path=package_root/pbr.get("roughness","")
if pbr and diffuse_path.is_file():
    pbr_mapping=n.new("ShaderNodeMapping"); scale=float(pbr.get("scale",3.5)); pbr_mapping.inputs["Scale"].default_value=(scale,scale,scale)
    rock_tex=n.new("ShaderNodeTexImage"); rock_tex.image=bpy.data.images.load(str(diffuse_path)); rock_tex.projection="BOX"; rock_tex.projection_blend=.25
    links.new(coord.outputs["Generated"],pbr_mapping.inputs["Vector"]); links.new(pbr_mapping.outputs["Vector"],rock_tex.inputs["Vector"]); links.new(rock_tex.outputs["Color"],rock_mix.inputs[2])
    if normal_path.is_file():
        rock_normal=n.new("ShaderNodeTexImage"); rock_normal.image=bpy.data.images.load(str(normal_path)); rock_normal.image.colorspace_settings.name="Non-Color"; rock_normal.projection="BOX"; rock_normal.projection_blend=.25
        normal_map=n.new("ShaderNodeNormalMap"); normal_map.inputs["Strength"].default_value=.32
        links.new(pbr_mapping.outputs["Vector"],rock_normal.inputs["Vector"]); links.new(rock_normal.outputs["Color"],normal_map.inputs["Color"]); links.new(normal_map.outputs["Normal"],bump.inputs["Normal"])
    if rough_path.is_file():
        rock_rough=n.new("ShaderNodeTexImage"); rock_rough.image=bpy.data.images.load(str(rough_path)); rock_rough.image.colorspace_settings.name="Non-Color"; rock_rough.projection="BOX"; rock_rough.projection_blend=.25
        links.new(pbr_mapping.outputs["Vector"],rock_rough.inputs["Vector"]); links.new(rock_rough.outputs["Color"],bsdf.inputs["Roughness"])
bsdf.inputs["Roughness"].default_value=.94; bsdf.inputs["Specular IOR Level"].default_value=.12; terrain.data.materials.append(mat)

# A deliberate beveled plinth turns the crop boundary into a designed map object.
if look["terrain"].get("showBase",False):
    base_depth=float(look["terrain"].get("baseDepth",.42)); base_margin=float(look["terrain"].get("baseMargin",.10))
    bpy.ops.mesh.primitive_cube_add(size=1,location=(0,0,-base_depth/2-.015))
    base=bpy.context.object; base.name="terrain-plinth"; base.dimensions=(span_x+base_margin,span_y+base_margin,base_depth); bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    bevel=base.modifiers.new("soft edges","BEVEL"); bevel.width=float(look["terrain"].get("baseBevel",.08)); bevel.segments=5
    bm=bpy.data.materials.new("plinth"); bm.use_nodes=True; bb=bm.node_tree.nodes.get("Principled BSDF"); bb.inputs["Base Color"].default_value=tuple(look["terrain"].get("baseColor",[.025,.075,.08,1])); bb.inputs["Roughness"].default_value=.78; base.data.materials.append(bm)

# Low-poly forest canopy is batched into three meshes. It is spatial texture, not hero trees.
veg = look.get("vegetation", {})
if veg.get("enabled", True) and veg.get("geometryEnabled", False):
    rng=np.random.default_rng(20260907); dzdy,dzdx=np.gradient(z,span_y/max(1,rows-1),span_x/max(1,cols-1))
    batches=[([],[]) for _ in range(3)]; stride=max(2,round(4/max(.08,float(veg.get("density",.26)))))
    z_limit=float(np.max(z))*float(veg.get("maximumElevationFraction",.72)); th=float(veg.get("treeHeightMeters",34))/1000
    for r in range(2,rows-2,stride):
        for c in range(2,cols-2,stride):
            if z[r,c]>z_limit or math.hypot(dzdx[r,c],dzdy[r,c])>float(veg.get("maximumSlope",.68)) or rng.random()>.82: continue
            x=c/(cols-1)*span_x-span_x/2; y=span_y/2-r/(rows-1)*span_y; h=th*rng.uniform(.72,1.25); rad=h*.24; bi=(r*17+c*31)%3
            vs,fs=batches[bi]; q=len(vs); vs.extend([(x-rad,y-rad,float(z[r,c])),(x+rad,y-rad,float(z[r,c])),(x+rad,y+rad,float(z[r,c])),(x-rad,y+rad,float(z[r,c])),(x,y,float(z[r,c])+h)])
            fs.extend([(q,q+1,q+4),(q+1,q+2,q+4),(q+2,q+3,q+4),(q+3,q,q+4)])
    for bi,(vs,fs) in enumerate(batches):
        fm=bpy.data.meshes.new(f"forest-{bi}"); fm.from_pydata(vs,[],fs); fm.update(); fo=bpy.data.objects.new(f"forest-{bi}",fm); bpy.context.collection.objects.link(fo)
        color=[(.022,.075,.018,1),(.035,.11,.025,1),(.055,.14,.035,1)][bi]
        material=bpy.data.materials.new(f"forest-{bi}"); material.use_nodes=True; material.diffuse_color=color
        fb=material.node_tree.nodes.get("Principled BSDF"); fb.inputs["Base Color"].default_value=color; fb.inputs["Roughness"].default_value=1
        fm.materials.append(material)

tree_asset=Path(__file__).resolve().parents[1]/veg.get("asset","")
if veg.get("enabled",True) and tree_asset.is_file():
    collection_name=veg.get("assetCollection","pine_sapling_small")
    with bpy.data.libraries.load(str(tree_asset),link=True) as (source, target):
        target.collections=[collection_name] if collection_name in source.collections else []
    if target.collections:
        tree_collection=target.collections[0]; rng=np.random.default_rng(20260907)
        dzdy,dzdx=np.gradient(z,span_y/max(1,rows-1),span_x/max(1,cols-1)); candidates=[]
        for _ in range(int(veg.get("instanceCount",450))*8):
            r=int(rng.integers(2,rows-2)); c=int(rng.integers(2,cols-2)); elev=z[r,c]/max(1e-6,float(z.max()))
            if elev>veg.get("maximumElevationFraction",.76) or math.hypot(dzdx[r,c],dzdy[r,c])>veg.get("maximumSlope",.68): continue
            candidates.append((r,c))
            if len(candidates)>=int(veg.get("instanceCount",450)): break
        base_scale=veg.get("treeHeightMeters",42)/1000/1.3
        for i,(r,c) in enumerate(candidates):
            tree=bpy.data.objects.new(f"pine-{i:04d}",None); tree.instance_type="COLLECTION"; tree.instance_collection=tree_collection
            tree.location=(c/(cols-1)*span_x-span_x/2,span_y/2-r/(rows-1)*span_y,float(z[r,c])); s=base_scale*rng.uniform(.72,1.18); tree.scale=(s,s,s); tree.rotation_euler[2]=rng.uniform(0,2*math.pi); bpy.context.collection.objects.link(tree)

def sample_z(lon, lat):
    cf=max(0,min(cols-1,(lon-west)/(east-west)*(cols-1)))
    rf=max(0,min(rows-1,(north-lat)/(north-south)*(rows-1)))
    c0,r0=int(math.floor(cf)),int(math.floor(rf)); c1,r1=min(cols-1,c0+1),min(rows-1,r0+1)
    tx,ty=cf-c0,rf-r0
    sampled=(z[r0,c0]*(1-tx)*(1-ty)+z[r0,c1]*tx*(1-ty)+z[r1,c0]*(1-tx)*ty+z[r1,c1]*tx*ty)
    return float(sampled)+look["routes"].get("heightMeters",8)/1000

def point(lon, lat):
    return ((lon-(west+east)/2)*111.3*math.cos(math.radians(lat_c)),
            (lat-(south+north)/2)*110.6, sample_z(lon,lat))

if data.get("water"):
    water_geo=json.loads((prepared/data["water"]).read_text(encoding="utf-8"))
    water_materials={}
    for i,feature in enumerate(water_geo.get("features",[])):
        geom=feature.get("geometry",{}); coords=geom.get("coordinates",[])
        if geom.get("type")!="LineString" or len(coords)<2: continue
        kind=feature.get("properties",{}).get("kind","stream"); width={"river":32,"water":24,"stream":12}.get(kind,8)
        curve=bpy.data.curves.new(f"water-{i}","CURVE"); curve.dimensions="3D"; curve.bevel_depth=width/2000; curve.bevel_resolution=3
        spline=curve.splines.new("POLY"); spline.points.add(len(coords)-1)
        for p,coord_pair in zip(spline.points,coords):
            x,y,zp=point(coord_pair[0],coord_pair[1]); p.co=(x,y,zp+.004,1)
        obj=bpy.data.objects.new(f"water-{i}",curve); bpy.context.collection.objects.link(obj)
        if kind not in water_materials:
            wm=bpy.data.materials.new(f"water-{kind}"); wm.use_nodes=True; wb=wm.node_tree.nodes.get("Principled BSDF"); wb.inputs["Base Color"].default_value=(.01,.18,.24,1); wb.inputs["Metallic"].default_value=.05; wb.inputs["Roughness"].default_value=.22
            water_materials[kind]=wm
        curve.materials.append(water_materials[kind])

if data.get("routes"):
    geo = json.loads((prepared / data["routes"]).read_text(encoding="utf-8"))
    features = geo.get("features", [geo])
    palette = [(0.93,.63,.18,1),(.16,.82,.46,1),(.18,.55,1,1)]
    route_objs = {}
    def _hex_rgba(h):
        h = h.lstrip("#"); return tuple(int(h[i:i+2],16)/255 for i in (0,2,4)) + (1,)
    for i, feature in enumerate(features):
        geom=feature.get("geometry",feature)
        if geom.get("type") != "LineString": continue
        props = feature.get("properties", {}) or {}
        curve=bpy.data.curves.new(f"route-{i}","CURVE"); curve.dimensions="3D"; curve.bevel_depth=look["routes"].get("widthMeters",8)/2000; curve.bevel_resolution=3
        coords=geom["coordinates"]; dense=[]
        for j in range(len(coords)-1):
            a,b=coords[j],coords[j+1]
            seg_m=math.hypot((b[0]-a[0])*111300*math.cos(math.radians((a[1]+b[1])/2)),(b[1]-a[1])*110600)
            steps=max(8,min(400,int(seg_m/90)))  # 按弧长加密：起伏地形上稀点弦切会悬空/穿山（D2 样片判例）
            for step in range(steps):
                u=step/steps; dense.append((a[0]+(b[0]-a[0])*u,a[1]+(b[1]-a[1])*u))
        dense.append(tuple(coords[-1][:2]))
        spline=curve.splines.new("POLY"); spline.points.add(len(dense)-1)
        for p,(lon,lat) in zip(spline.points,dense): p.co=(*point(lon,lat),1)
        obj=bpy.data.objects.new(f"route-{i}",curve); bpy.context.collection.objects.link(obj)
        obj["segmentId"] = props.get("id", f"route-{i}")
        route_objs[obj["segmentId"]] = obj
        obj.hide_render = shot["cameraPreset"] != "route-overview" and not shot.get("animation")
        col = _hex_rgba(props["color"]) if props.get("color") else palette[i%len(palette)]
        rm=bpy.data.materials.new(f"route-{i}"); rm.diffuse_color=col; rm.use_nodes=True
        rb=rm.node_tree.nodes.get("Principled BSDF"); rb.inputs["Base Color"].default_value=col; rb.inputs["Emission Color"].default_value=col; rb.inputs["Emission Strength"].default_value=look["routes"].get("emissionStrength",.30)
        rb.inputs["Roughness"].default_value=look["routes"].get("roughness",.95); rb.inputs["Metallic"].default_value=0.0  # 细管全身镜面高光会脱色发白（D2 样片判例）
        obj.data.materials.append(rm)

world=bpy.data.worlds.new("morning"); scene.world=world; world.use_nodes=True; world.color=(.16,.28,.42)
wn=world.node_tree.nodes; wl=world.node_tree.links; wn.clear()
wout=wn.new("ShaderNodeOutputWorld"); bg=wn.new("ShaderNodeBackground"); lighting=look["lighting"]
wcoord=wn.new("ShaderNodeTexCoord"); bg.inputs["Strength"].default_value=lighting.get("worldStrength",.75)
hdri_path=Path(__file__).resolve().parents[1]/lighting.get("hdri","")
if lighting.get("hdri") and hdri_path.is_file():
    env=wn.new("ShaderNodeTexEnvironment"); env.image=bpy.data.images.load(str(hdri_path)); mapping=wn.new("ShaderNodeMapping"); mapping.inputs["Rotation"].default_value[2]=math.radians(lighting.get("hdriRotationDegrees",0))
    wl.new(wcoord.outputs["Generated"],mapping.inputs["Vector"]); wl.new(mapping.outputs["Vector"],env.inputs["Vector"]); wl.new(env.outputs["Color"],bg.inputs["Color"])
else:
    wsep=wn.new("ShaderNodeSeparateXYZ"); sky_height=wn.new("ShaderNodeMapRange"); sky_ramp=wn.new("ShaderNodeValToRGB"); sky_height.inputs["From Min"].default_value=-.15; sky_height.inputs["From Max"].default_value=.75; sky_height.clamp=True
    sky_ramp.color_ramp.elements[0].color=tuple(lighting.get("horizonColor",(.72,.66,.54,1))); sky_ramp.color_ramp.elements[1].color=tuple(lighting.get("zenithColor",(.12,.24,.38,1))); wl.new(wcoord.outputs["Normal"],wsep.inputs[0]); wl.new(wsep.outputs["Z"],sky_height.inputs["Value"]); wl.new(sky_height.outputs["Result"],sky_ramp.inputs[0]); wl.new(sky_ramp.outputs["Color"],bg.inputs["Color"])
wl.new(bg.outputs["Background"],wout.inputs["Surface"])

atmosphere=look.get("atmosphere",{}); bpy.ops.mesh.primitive_cube_add(size=2,location=(0,0,4))
haze=bpy.context.object; haze.name="aerial-perspective"; haze.scale=(span_x*2,span_y*2,6)
hm=bpy.data.materials.new("aerial perspective"); hm.use_nodes=True; hn=hm.node_tree.nodes; hl=hm.node_tree.links; hn.clear(); hout=hn.new("ShaderNodeOutputMaterial"); hv=hn.new("ShaderNodeVolumeScatter"); hv.inputs["Color"].default_value=tuple(atmosphere.get("aerialColor",(.35,.48,.62,1))); hv.inputs["Density"].default_value=atmosphere.get("aerialDensity",.008); hv.inputs["Anisotropy"].default_value=.12; hl.new(hv.outputs["Volume"],hout.inputs["Volume"]); haze.data.materials.append(hm)
az=math.radians(lighting.get("azimuthDegrees",118)); el=math.radians(lighting.get("elevationDegrees",9)); sun_to_scene=-Vector((math.cos(el)*math.cos(az),math.cos(el)*math.sin(az),math.sin(el)))
bpy.ops.object.light_add(type="SUN", location=(-span_x, -span_y, 8)); sun=bpy.context.object; sun.rotation_euler=sun_to_scene.to_track_quat('-Z','Y').to_euler(); sun.data.energy=lighting.get("sunEnergy",3.2); sun.data.color=(1,.72,.50); sun.data.angle=math.radians(lighting.get("sunAngleDegrees",1))
if lighting.get("studioLights",False):
    light_target=Vector((0,0,float(np.quantile(z,.48))))
    bpy.ops.object.light_add(type="AREA", location=(-span_x*.65,-span_y*.55,8.5)); key=bpy.context.object; key.name="warm-key"; key.data.energy=lighting.get("keyEnergy",1400); key.data.shape="DISK"; key.data.size=lighting.get("keySize",5.5); key.data.color=(1.0,.68,.42); key.rotation_euler=(light_target-key.location).to_track_quat('-Z','Y').to_euler()
    bpy.ops.object.light_add(type="AREA", location=(span_x*.7,span_y*.75,6.5)); rim=bpy.context.object; rim.name="cool-rim"; rim.data.energy=lighting.get("rimEnergy",850); rim.data.shape="DISK"; rim.data.size=lighting.get("rimSize",4.0); rim.data.color=(.30,.58,1.0); rim.rotation_euler=(light_target-rim.location).to_track_quat('-Z','Y').to_euler()

peak_r,peak_c=np.unravel_index(np.argmax(z),z.shape); peak=Vector((peak_c/(cols-1)*span_x-span_x/2,span_y/2-peak_r/(rows-1)*span_y,float(z[peak_r,peak_c])))
bpy.ops.object.camera_add(); camera=bpy.context.object; scene.camera=camera; camera.data.lens=58
if shot["cameraPreset"]=="ridge-reveal": camera.location=peak+Vector((-span_x*.28,-span_y*.34,.92)); target=peak+Vector((span_x*.035,span_y*.015,-.12)); camera.data.lens=70
elif shot["cameraPreset"]=="route-overview": camera.location=peak+Vector((-span_x*.23,-span_y*.34,max(span_x,span_y)*.48)); target=peak+Vector((span_x*.06,span_y*.05,-float(z.max())*.18)); camera.data.lens=55
else: camera.location=peak+Vector((-span_x*.25,-span_y*.37,max(span_x,span_y)*.47)); target=peak+Vector((span_x*.05,span_y*.06,-float(z.max())*.20)); camera.data.lens=53
direction=target-camera.location; camera.rotation_euler=direction.to_track_quat('-Z','Y').to_euler()
scene.view_settings.look="AgX - Medium High Contrast"; scene.view_settings.exposure=look.get("color",{}).get("exposure",.35)
focus=bpy.data.objects.new("focus",None); bpy.context.collection.objects.link(focus); focus.location=target
dof_cfg=look.get("dof",{}); camera.data.dof.use_dof=dof_cfg.get("enabled",True); camera.data.dof.focus_object=focus; camera.data.dof.aperture_fstop=dof_cfg.get("fstop",7.1)

out_dir=scene_path.parent/spec["output"]["directory"]; out_dir.mkdir(parents=True,exist_ok=True)
anim = shot.get("animation")
if not anim:
    scene.render.filepath=str(out_dir/f"{shot_id}.png")
    bpy.ops.render.render(write_still=True)
    print(f"RENDERED {scene.render.filepath}")
else:
    # 动画分支：相机路径关键帧（数学插值，无瓦片无 z 级跳变——MapLibre 幌动判例的根治）
    # + 路线 bevel_factor 弧长生长 + 节点逐帧屏幕坐标导出（合成层标签锚定）
    fps=int(anim.get("fps",30)); dur=float(anim["durationSeconds"])
    scene.render.fps=fps
    nfr=int(round(dur*fps)); scene.frame_start=0; scene.frame_end=nfr
    def cam_vec(lonlat, alt_m):
        px, py = point(lonlat[0], lonlat[1])[:2]
        return Vector((px, py, (alt_m-z0)/1000*exag))
    for kf in anim.get("cameraPath", []):
        loc = cam_vec(kf["at"], kf["altitudeMeters"])
        tp = point(kf["lookAt"][0], kf["lookAt"][1]); tgt = Vector((tp[0], tp[1], tp[2]+kf.get("lookAtLiftMeters",0)/1000))
        camera.location = loc
        camera.rotation_euler = (tgt-loc).to_track_quat('-Z','Y').to_euler()
        camera.data.lens = kf.get("lens", 55)
        f = kf["frame"]
        camera.keyframe_insert("location", frame=f)
        camera.keyframe_insert("rotation_euler", frame=f)
        camera.data.keyframe_insert("lens", frame=f)
        focus.location = tgt
        focus.keyframe_insert("location", frame=f)
    for rg in anim.get("routeGrowth", []):
        robj = route_objs.get(rg["segment"])
        if not robj: continue
        cd = robj.data
        cd.bevel_factor_mapping_end = 'SPLINE'  # 按样条弧长生长，dense 均布点近似匀速
        cd.bevel_factor_end = 0.0
        cd.keyframe_insert("bevel_factor_end", frame=rg["fromFrame"])
        cd.bevel_factor_end = 1.0
        cd.keyframe_insert("bevel_factor_end", frame=rg["toFrame"])
    markers = anim.get("trackMarkers", [])
    tracks = {m["id"]: [] for m in markers}
    frames_dir = out_dir / f"{shot_id}_frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(frames_dir / "f_")
    if markers:
        from bpy_extras.object_utils import world_to_camera_view
        for f in range(scene.frame_start, scene.frame_end + 1):
            scene.frame_set(f)
            for m in markers:
                tp = point(m["at"][0], m["at"][1])
                co = world_to_camera_view(scene, camera, Vector((tp[0], tp[1], tp[2])))
                tracks[m["id"]].append({"frame": f, "x": round(co.x, 5), "y": round(co.y, 5), "z": round(co.z, 4)})
        (out_dir / f"{shot_id}-markers.json").write_text(json.dumps(tracks), encoding="utf-8")
    bpy.ops.render.render(animation=True)
    print(f"RENDERED {nfr+1} frames -> {frames_dir}")
