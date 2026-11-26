"""Shape 3: bottle, a revolved G2 meridian (barrel body, G2 shoulder blend, neck), planar caps."""
from blocks import *
NAME='s3_bottle'
DEFAULT=dict(R=30.0, H=110.0, neckR=11.0, neckH=25.0, barrel=250.0)
def meridian(p):
    R,H,nr,nh,bR=p['R'],p['H'],p['neckR'],p['neckH'],p['barrel']
    hb=0.62*H  # body height
    # body: arc of radius bR bulging outward, from (R,0) to (R,hb) in xz plane
    cx=R-bR*math.cos(math.asin((hb/2)/bR)); a=math.degrees(math.asin((hb/2)/bR))
    body=arc((cx,0,hb/2),bR,-a,2*a,normal=(0,-1,0))
    # neck: gentle concave arc from (nr, H-nh) to (nr, H)
    nR=150.0; ncx=nr+nR*math.cos(math.asin((nh/2)/nR)); na=math.degrees(math.asin((nh/2)/nR))
    neck=arc((ncx,0,H-nh/2),nR,180-na,2*na,normal=(0,-1,0))
    return body,neck
def build(p):
    body,neck=meridian(p)
    br=bridge_g2(body,neck)
    join_curves([body,br,neck])
    w=wires()[0]
    S=revolve(w); delete(wires())
    for z in (0.0, p['H']):
        e=min(edges(S,True),key=lambda e:abs(e['boundsMm']['max'][2]-z)+abs(e['boundsMm']['min'][2]-z))
        planar_cap(S,[e['id']])
    return S
def plan(p):
    return [dict(name='body/shoulder',select=dict(zRing=0.62*p['H']),target='G2',expectCount=1),
            dict(name='shoulder/neck',select=dict(zRing=p['H']-p['neckH']),target='G2',expectCount=1),
            dict(name='caps',select=dict(rest=True),target='sharp')]
def dims(p, body): return {}
