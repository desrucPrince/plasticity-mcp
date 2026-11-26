"""Reusable surfacing building blocks for the Plasticity MCP (proven on 26.1.3).
Every block returns body ids and leaves no stray Wires unless asked.

Core rule (measured): plasticity_loft_curves with edge profiles ({bodyId, edgeId}) and curvature 'clamped'
makes the new surface G2 to each edge's face, by construction, also with guides, as long as the guides
leave each profile tangent (and with matching curvature) to that face. Wire profiles stay positional (G0)."""
from core import *

def arc(center, r, start, sweep, normal=(0,0,1), xdir=(1,0,0)):
    return added(batch([{'toolName':'plasticity_create_center_arc','arguments':{'centerMm':list(center),'radiusMm':r,'startAngleDegrees':start,'sweepAngleDegrees':sweep,'normal':list(normal),'xDirection':list(xdir)}}]))[0]
def plane_curve(plane, pts, offset=None, **kw):
    a={'plane':plane,'points2dMm':[list(p) for p in pts],'mode':kw.pop('mode','control')}
    if offset is not None: a['offsetMm']=offset
    a.update(kw)
    return added(batch([{'toolName':'plasticity_create_plane_curve','arguments':a}]))[0]
def cp_curve(pts):
    return added(batch([{'toolName':'plasticity_create_control_point_curve','arguments':{'pointsMm':[list(p) for p in pts]}}]))[0]
def revolve(wire, origin=(0,0,0), axis=(0,0,1), angle=360):
    return added(batch([{'toolName':'plasticity_revolve_profile','arguments':{'id':wire,'axisOriginMm':list(origin),'axis':list(axis),'angleDegrees':angle}}]))[0]
def extrude(wire, distance, direction):
    return added(batch([{'toolName':'plasticity_extrude_curves','arguments':{'ids':[wire],'distanceMm':distance,'direction':list(direction)}}]),'Sheet')[0]
def g2_loft(profiles, guides=(), curvature='clamped', **kw):
    """profiles: list of (bodyId, edgeId) tuples (G2 to that face when clamped) or Wire ids (positional)."""
    P=[{'bodyId':p[0],'edgeId':p[1]} if isinstance(p,tuple) else {'wireId':p} for p in profiles]
    a={'profiles':P,'curvature':curvature}; a.update(kw)
    if guides: a['guideIds']=list(guides)
    return added(batch([{'toolName':'plasticity_loft_curves','arguments':a}]),'Sheet')[0]
def join(ids):
    before=set(bodies()); call('plasticity_join_sheets',{'ids':list(ids),'revision':rev()})
    after=bodies(); keep=[i for i in ids if i in after]
    return keep[0] if keep else [i for i in after if i not in before][0]
def planar_cap(body, edge_ids):
    """Fill a planar hole bounded by edge_ids of body with a G0 patch (a sharp, intended crease) and keep one body."""
    batch([{'toolName':'plasticity_patch_sheet_hole','arguments':{'id':body,'edgeIds':list(edge_ids),'continuity':'g0'}}])
    return body
def mirror_join(body, origin=(0,0,0), normal=(1,0,0)):
    r=batch([{'toolName':'plasticity_mirror','arguments':{'ids':[body],'planeOriginMm':list(origin),'planeNormal':list(normal),'keepOriginal':True}}])
    m=added(r)[0]; return join([body,m])
def segments():
    return {c['id']:c for c in call('plasticity_list_curve_directions',{})['curves']}
def bridge_g2(w1, w2, t1=None, t2=None, cont='G2'):
    """G2 bridge between the nearest ends of two single-segment Wires. Returns the new Wire id."""
    s=segments(); a=s[w1]['segments'][0]; b=s[w2]['segments'][0]
    ends=[(math.dist(a[ea+'Mm'],b[eb+'Mm']),ea,eb) for ea in ('start','end') for eb in ('start','end')]
    _,ea,eb=min(ends)
    f={'bodyId':w1,'segmentEntityId':a['entityId'],'at':ea}; g={'bodyId':w2,'segmentEntityId':b['entityId'],'at':eb}
    if t1 is not None: f['tensionG1Mm']=t1
    if t2 is not None: g['tensionG1Mm']=t2
    return added(batch([{'toolName':'plasticity_bridge_curves','arguments':{'first':f,'second':g,'startContinuity':cont,'endContinuity':cont}}]))[0]
def join_curves(ids):
    before=set(bodies()); batch([{'toolName':'plasticity_join_curves','arguments':{'ids':list(ids)}}])
    after=bodies(); return [i for i in after if after[i]['type']=='Wire' and (i in ids or i not in before)]
