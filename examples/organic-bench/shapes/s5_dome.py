"""Shape 5: dome on a ring. Ring = revolved bulging band; dome = Indie patch of the top hole at G2 (a trimmed cap)."""
from blocks import *
NAME='s5_dome'
DEFAULT=dict(R=35.0, H=30.0, bulge=120.0)
def build(p):
    R,H,bR=p['R'],p['H'],p['bulge']
    a=math.degrees(math.asin((H/2)/bR)); cx=R-bR*math.cos(math.radians(a))
    w=arc((cx,0,H/2),bR,-a,2*a,normal=(0,-1,0))
    S=revolve(w); delete([w])
    top=min(edges(S,True),key=lambda e:abs(e['boundsMm']['min'][2]-H)+abs(e['boundsMm']['max'][2]-H))
    batch([{'toolName':'plasticity_patch_sheet_hole','arguments':{'id':S,'edgeIds':[top['id']],'continuity':'g2'}}])
    bot=min(edges(S,True),key=lambda e:abs(e['boundsMm']['min'][2])+abs(e['boundsMm']['max'][2]))
    planar_cap(S,[bot['id']])
    return S
def plan(p):
    return [dict(name='ring/dome',select=dict(zRing=p['H']),target='G2',expectCount=1),
            dict(name='base',select=dict(rest=True),target='sharp')]
def dims(p, body): return {}
