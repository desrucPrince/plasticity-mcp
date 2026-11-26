"""Speaker, recipe B: attempt-3 topology (face, band, flank, side, back, wrap) with the side and back rebuilt as
untrimmed lofts whose smooth joins are clamped edge profiles (G2 by construction)."""
from blocks import *
import s4_speaker as A
import json, os
NAME='s4_speaker'
DEFAULT=dict(A.DEFAULT); NO_SWEEP=A.NO_SWEEP; SWEEP=A.SWEEP
NK0=[[42.5,-4,55],[44.2,0,28],[46.8,7,11]]
OPTS=dict(back='loft', backSections=0)
def stage_half(p):
    F=A.frame(p); ZB=p['zb']; hw,hd=p['baseHW'],p['baseHD']; sy=18.0*hd/56
    face=A.build_face(p,F); ol=A.build_outline(p); A.cut_half([face])
    face=[i for i,x in bodies().items() if x['type']=='Sheet'][0]
    fl=A.build_flank(p,F,face,ol['front'][2])
    # band: the face's upper cap edge extruded straight back along -n by 'band'
    capw=A.guide_from_edge(face,F['c2'],F['top'])
    band=extrude(capw,p['band'],F['m']); delete([capw])
    Hc=A.vec(F['c2'],F['m'],p['band']); Tb=A.vec(F['top'],F['m'],p['band'])
    return F,face,ol,fl,band,Hc,Tb
def neck_curve(p,F,Hc):
    mu=[-c for c in F['u']]; ZB=p['zb']; hw,hd=p['baseHW'],p['baseHD']; sy=18.0*hd/56
    NK=[Hc,A.vec(Hc,mu,8),A.vec(Hc,mu,16)]+[[q[0]*hw/49.5,q[1]*hd/56,q[2]] for q in NK0]+[[hw,sy,ZB]]
    return cp_curve(NK)
def build_side(p,F,fl,band,Hc,ol):
    ZB=p['zb']; hw=p['baseHW']; sy=18.0*p['baseHD']/56
    nk=neck_curve(p,F,Hc)
    fe=edge_by_ends(fl,F['c2'],[hw,0,ZB],True,tol=0.05)
    be=edge_by_ends(band,F['c2'],Hc,True,tol=0.05)
    bw=A.extract(band,be)
    side=g2_loft([(fl,fe['id']),nk],guides=[bw,ol['rear'][0]])
    delete([bw,nk])
    return side
