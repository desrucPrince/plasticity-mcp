"""Negative controls: joins the gate MUST reject. A curvature jump (arc R20 tangent to arc R40, G1 only) and a
0.3 degree crease. The runner counts a control as OK when its plan FAILS."""
from blocks import *
NAME="s0_controls"
EXPECT_FAIL=True
EXPECT_SOLID=False
DEFAULT=dict(r1=20.0, r2=40.0, crease=0.0)
def build(p):
    r1,r2,cr=p['r1'],p['r2'],p['crease']
    a1=arc((0,0,0),r1,0,60)                         # ends at angle 60 on circle r1
    e=(r1*math.cos(math.radians(60)), r1*math.sin(math.radians(60)))
    # second arc: tangent at e (G1), radius r2, same turning sense, plus a small crease angle
    ang=60+cr
    c2=(e[0]-r2*math.cos(math.radians(ang)), e[1]-r2*math.sin(math.radians(ang)), 0)
    a2=arc(c2,r2,ang,40)
    w=join_curves([a1,a2]); S=extrude(w[0],30,(0,0,1)); delete(wires())
    return S
def plan(p):
    return [dict(name='curvature jump + crease must not pass G2',select=dict(vertical=True),target='G2',expectCount=1),
            dict(name='rest',select=dict(rest=True),target='any')]
def dims(p, body): return {}
