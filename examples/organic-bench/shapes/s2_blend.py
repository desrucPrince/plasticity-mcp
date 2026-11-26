"""Shape 2: two doubly curved panels joined by a G2 edge-loft blend (no boolean). Open Sheet."""
from blocks import *
NAME='s2_blend'
EXPECT_SOLID=False
DEFAULT=dict(gap=40.0, h=30.0, wave=3.0)
def build(p):
    g=p['gap']; h=p['h']; w=p['wave']
    A_prof=[[[0,y,0],[12,y,6+0.1*(y-30)**2/30],[25,y,18],[30,y,h+w*math.sin(y/20)]] for y in (0,30,60)]
    B_prof=[[[30+g,y,h+10+2*math.cos(y/25)],[38+g,y,h],[50+g,y,22-0.05*(y-30)**2/10],[60+g,y,10]] for y in (0,30,60)]
    wa=[cp_curve(q) for q in A_prof]; wb=[cp_curve(q) for q in B_prof]
    A=g2_loft(wa,curvature='unconstrained'); Bs=g2_loft(wb,curvature='unconstrained'); delete(wa+wb)
    ea=max(edges(A,True),key=lambda e:e['centerMm'][0]); eb=min(edges(Bs,True),key=lambda e:e['centerMm'][0])
    L=g2_loft([(A,ea['id']),(Bs,eb['id'])])
    return join([A,L,Bs])
def plan(p):
    g=p['gap']
    return [dict(name='panelA/blend',select=dict(xPlaneEdge=30.0),target='G2',expectCount=1),
            dict(name='blend/panelB',select=dict(xPlaneEdge=30.0+g),target='G2',expectCount=1),
            dict(name='rest',select=dict(rest=True),target='any')]
def dims(p, body): return {}
