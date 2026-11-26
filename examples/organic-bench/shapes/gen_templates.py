"""Generate s4 section templates from the attempt-3 speaker (out3), so the new lofts reproduce its shape."""
import sys,json
from blocks import *
import s4_speaker as s
p=s.DEFAULT
wipe(); F,face,ol,fl=s.stage1(p)
top=s.orient(s.wire_poly(s.guide_from_edge(face,F['c2'],F['top'])),F['c2'])
rear=join_curves(ol['rear'])[0] if len(ol['rear'])>1 else ol['rear'][0]
bot=s.orient(s.wire_poly(rear),[p['baseHW'],0,p['zb']])
wtop=s.orient(s.wire_poly(s.guide_from_edge(face,F['c1'],F['O']) if False else s.guide_from_edge(face,F['c1'],[0,-50,34])),F['c1'])
front=join_curves([ol['front'][0],ol['front'][1]])[0]
wbot=s.orient(s.wire_poly(front),[p['baseHW'],-18.0,p['zb']])
json.dump(dict(top=top,bot=bot,wtop=wtop,wbot=wbot),open(ROOT+'/bench/shapes/s4_guides_base.json','w'))
open_doc(ROOT+'/out4/baseline.plasticity',ROOT+'/bench/runs/_backups')
body=solids()[0]
T=dict(shell=s.make_templates(top,bot,body,[0.2,0.4,0.6,0.8],s.INSIDE_SHELL), wrap=s.make_templates(wtop,wbot,body,[0.5],s.INSIDE_WRAP))
json.dump(T,open(s.TEMPL,'w'),indent=1)
for k,v in T.items():
    for t in v: print(k,t['s'],len(t['points']),'max|n-dev|=%.4f'%max(abs(q[2]) for q in t['points']))
