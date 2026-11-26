"""Shape 1: soft box, a closed outline of four large arcs joined by G2 corner bridges, extruded; planar caps."""
from blocks import *
NAME='s1_softbox'
DEFAULT=dict(W=80.0, D=60.0, H=40.0, side=150.0, corner=14.0)
def outline(p):
    W,D,R,c=p['W'],p['D'],p['side'],p['corner']
    ws=[]
    # four side arcs, each bulging outward, spanning the side minus the corner allowance
    for (cx,cy,ang,half_len) in ((W/2,0,0,D/2-c),(0,D/2,90,W/2-c),(-W/2,0,180,D/2-c),(0,-D/2,270,W/2-c)):
        a=math.degrees(math.asin(half_len/R))
        ux,uy=math.cos(math.radians(ang)),math.sin(math.radians(ang))
        ctr=(cx-ux*(R*math.cos(math.radians(a))),cy-uy*(R*math.cos(math.radians(a))),0)
        ws.append(arc(ctr,R,ang-a,2*a))
    br=[bridge_g2(ws[i],ws[(i+1)%4]) for i in range(4)]
    return join_curves(ws+br)
def build(p):
    w=outline(p); assert len(w)==1, w
    S=extrude(w[0],p['H'],(0,0,1)); delete(wires())
    for z in (0.0,p['H']):
        es=[e['id'] for e in edges(S,True) if abs(e['boundsMm']['min'][2]-z)<1e-3 and abs(e['boundsMm']['max'][2]-z)<1e-3]
        planar_cap(S,es)
    return S
def plan(p):
    return [dict(name='walls',select=dict(vertical=True),target='G2',expectCount=8),
            dict(name='caps',select=dict(rest=True),target='sharp')]
def dims(p, body): return {}
