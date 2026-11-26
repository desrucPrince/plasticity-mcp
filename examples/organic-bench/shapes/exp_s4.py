import sys, json, time, os
from blocks import *
import s4_speaker as s
tag=sys.argv[1]; s.SHELL_S=tuple(float(x) for x in sys.argv[2].split(',')) if sys.argv[2]!='-' else (); s.NCTRL=int(sys.argv[3])
s.V2=len(sys.argv)>4; s.USE_FAMILY=len(sys.argv)>5
if os.environ.get('TMIN'): s.TMIN=float(os.environ['TMIN'])
if os.environ.get('BCUT'): s.BANDCUT_MM=float(os.environ['BCUT'])
if os.environ.get('GAMMA'): s.DESIGN.update(on=True,gamma=float(os.environ['GAMMA']),amp=float(os.environ.get('AMP','1')))
if os.environ.get('NOSIMP'): s.LOFTKW={'simplify':False}
p=dict(s.DEFAULT); p['details']=0.0
import os
if os.environ.get('BAND') is not None: p['band']=float(os.environ['BAND'])
wipe(); t=time.time(); S=(s.build_v2 if s.V2 else s.build)(p); bt=time.time()-t
d=s.dims(dict(s.DEFAULT),S); fr=s.fairness(S)
r=C('plasticity_continuity_report',{'bodyId':S,'normalAngleToleranceDeg':0.1})
sm=[(e['edgeId'],e['class'],e['interiorClass'],round(e['normalAngleDeg']['max'],4),round(e['relativeCurvature']['interiorMax'],3)) for e in r['edges'] if e['normalAngleDeg']['interiorMax']<5]
print(tag,'build %.0fs'%bt,'fit',s.FITLOG,'\n sil',{k:(round(v['headY'],2),round(v['neckY'],2),round(v['pinch'],2)) for k,v in d['sil'].items()},'worst dev %.2f'%d.get('worstMm',-1),'KEY %.2f'%max(abs(d['sil'][x][k]-json.load(open(s.REF))['sil'][x][k]) for x in d['sil'] for k in ('headY','neckY','pinch')),'\n fair',fr,sum(fr.values()),'\n smooth edges',sm)
save(ROOT+'/bench/cap/exp-%s.plasticity'%tag)
for name,eye in (('front34',[330,-360,190]),('side',[450,0.01,72]),('rear',[0.01,450,90])):
    call('plasticity_set_camera',{'eyeMm':eye,'targetMm':[0,0,72],'frameRadiusMm':100}); time.sleep(1.2)
    call('plasticity_screenshot',{'path':ROOT+'/bench/cap/exp-%s-%s.png'%(tag,name),'overwrite':True,'captureMode':'viewport','shader':'zebraVertical'})
from PIL import Image
ims=[Image.open(ROOT+'/bench/cap/exp-%s-%s.png'%(tag,v)).convert('RGB') for v in ('front34','side','rear')]
w,h=ims[0].size; k=0.4; Cc=Image.new('RGB',(int(3*w*k),int(h*k)))
for i,im in enumerate(ims): Cc.paste(im.resize((int(w*k),int(h*k))),(int(i*w*k),0))
Cc.save(ROOT+'/bench/cap/exp-%s.png'%tag)
