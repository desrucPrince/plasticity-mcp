"""Benchmark entry for the speaker, option A (no band): v2 symmetric shell loft + wrap loft, sections from the
attempt-3 shape with the band zone removed."""
import s4_speaker as S
from blocks import *
NAME='s4_speaker'
DEFAULT=dict(S.DEFAULT); DEFAULT['band']=0.0
NO_SWEEP=('zb','capT','details','band'); SWEEP={'tiltDeg':(-3,3)}
S.SHELL_S=(0.25,0.6); S.NCTRL=7; S.BANDCUT_MM=26.0
KEY=json.load(open(S.REF))['sil'] if os.path.exists(S.REF) else None
def build(p): return S.build_v2(p)
def plan(p):
    F=S.frame(p); hw,hd,ZB=p['baseHW'],p['baseHD'],p['zb']; sy=18.0*hd/56; m=lambda q:[-q[0],q[1],q[2]]
    return [dict(name='flank/shell R',select=dict(endsNearMm=[F['c2'],[hw,0,ZB]],tol=0.5),target='G2',expectCount=1),
            dict(name='flank/shell L',select=dict(endsNearMm=[m(F['c2']),[-hw,0,ZB]],tol=0.5),target='G2',expectCount=1),
            dict(name='flank/wrap R',select=dict(endsNearMm=[F['c1'],[hw,-sy,ZB]],tol=0.5),target='G2',expectCount=1),
            dict(name='flank/wrap L',select=dict(endsNearMm=[m(F['c1']),[-hw,-sy,ZB]],tol=0.5),target='G2',expectCount=1),
            dict(name='other smooth joins G1 <= 0.1 deg',select=dict(predicate=lambda e,g: e['normalAngleDeg']['interiorMax']<5),target='G1'),
            dict(name='creases',select=dict(rest=True),target='any')]
def dims(p, body):
    s=S.silhouette(body); out=dict(sil={k:{kk:round(v[kk],2) for kk in ('headY','headZ','neckY','neckZ','pinch')} for k,v in s.items()})
    if KEY and all(p[k]==DEFAULT[k] for k in DEFAULT):
        dev={'x=%s %s'%(x,k):round(abs(s[x][k]-KEY[x][k]),2) for x in s for k in ('headY','neckY','pinch')}
        out['deviationFromAttempt3Mm']=dev; out['worstMm']=max(dev.values())
        out['centrelineWorstMm']=max(v for k,v in dev.items() if k.startswith('x=0 '))
        out['ok']=out['centrelineWorstMm']<=0.5   # off-centre dims are information: option A removed the band
    out['fairness']=S.fairness(body)
    return out
