"""Benchmark runner. usage: PLD_PORT=... python3.11 run_bench.py RUN_LABEL [--sweep] [--shapes a,b]
Builds every shape from an empty document, applies the continuity gate, saves .plasticity, STEP (+ re-import check),
zebra PNGs and a JSON of numbers to bench/runs/<run-id>/, and compares with the previous run."""
import sys, os, json, time, glob, traceback, importlib
HERE=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,os.path.join(HERE,'lib')); sys.path.insert(0,os.path.join(HERE,'shapes'))
from core import *
import gate
RUNS=os.path.join(HERE,'runs')
SHAPES=['s0_controls','s0b_crease','s0c_oldspeaker','s1_softbox','s2_blend','s3_bottle','s5_dome','s4_speaker_bench']
def variants(mod, sweep):
    base=dict(mod.DEFAULT); out=[('base',base)]
    if sweep:
        for k,v in base.items():
            if k in getattr(mod,'NO_SWEEP',()) or not isinstance(v,(int,float)): continue
            for f in getattr(mod,'SWEEP',{}).get(k,(0.95,1.05)):
                q=dict(base); q[k]=v*f if not k.endswith('Deg') else v+(f if abs(f)>1.5 else 0)
                out.append(('%s*%.2f'%(k,f),q))
    return out
def shots(body, path_prefix):
    b=bodies()[body]['boundsMm']; c=[(b['min'][i]+b['max'][i])/2 for i in range(3)]; r=max(b['max'][i]-b['min'][i] for i in range(3))
    out=[]
    for name,d in (('front34',(0.7,-0.8,0.45)),('rear34',(-0.6,0.8,0.35))):
        call('plasticity_set_camera',{'eyeMm':[c[i]+d[i]*r*3 for i in range(3)],'targetMm':c,'frameRadiusMm':r*0.75}); time.sleep(1.0)
        p='%s-zebra-%s.png'%(path_prefix,name)
        call('plasticity_screenshot',{'path':p,'overwrite':True,'captureMode':'viewport','shader':'zebraVertical'}); out.append(p)
    return out
def run_one(mod, vname, p, outdir):
    rec=dict(shape=mod.NAME,variant=vname,params=p); t0=time.time()
    tag=('%s__%s'%(mod.NAME,vname)).replace('*','x')
    try:
        wipe(); body=mod.build(p); rec['buildSec']=round(time.time()-t0,1)
        bs=bodies(); extra=[i for i in bs if i!=body]
        if extra: delete(extra)
        rec['body']=dict(id=body,type=bs[body]['type'],faces=bs[body]['faceCount'],edges=bs[body]['edgeCount'])
        v=call('plasticity_validate_bodies',{'ids':[body],'revision':rev()})['bodies'][0]
        rec['valid']=dict(closed=v['closed'],nativeValid=v['nativeValid'],boundaryEdges=len(v['boundaryEdgeIds']))
        g=gate.evaluate(body, mod.plan(p), getattr(mod,'GATE_DEFAULTS',None)); rec['gate']=g
        rec['dims']=mod.dims(p, body)
        save(os.path.join(outdir,tag+'.plasticity'))
        sp=os.path.join(outdir,tag+'.step')
        call('plasticity_export_step',{'ids':[body],'path':sp,'overwrite':True,'revision':rev()})
        before=set(bodies()); call('plasticity_import_step',{'path':sp,'revision':rev()})
        imp=[i for i in bodies() if i not in before]
        vi=call('plasticity_validate_bodies',{'ids':imp,'revision':rev()})['bodies'] if imp else []
        rec['stepReimport']=[dict(type=x['type'],faces=x['faceCount'],closed=x['closed'],nativeValid=x['nativeValid']) for x in vi]
        delete(imp)
        rec['shots']=shots(body, os.path.join(outdir,tag)) if vname=='base' else []
        solid_ok = (not getattr(mod,'EXPECT_SOLID',True)) or (rec['body']['type']=='Solid' and v['closed'])
        step_ok = len(vi)==1 and vi[0]['nativeValid'] and (vi[0]['type']==rec['body']['type'])
        gate_ok = (not g['pass_']) if getattr(mod,'EXPECT_FAIL',False) else g['pass_']
        rec['ok']=bool(gate_ok and v['nativeValid'] and solid_ok and step_ok and rec['dims'].get('ok',True))
        rec['why']=None if rec['ok'] else dict(gate=gate_ok,valid=v['nativeValid'],solid=solid_ok,step=step_ok,dims=rec['dims'].get('ok',True),firstFailure=g['firstFailure'])
    except Exception as ex:
        rec['ok']=False; rec['error']=str(ex)[:1500]; rec['trace']=traceback.format_exc()[-1500:]
    rec['sec']=round(time.time()-t0,1)
    return rec
def main():
    label=sys.argv[1]; sweep='--sweep' in sys.argv
    sh=[a for a in sys.argv if a.startswith('--shapes=')]
    names=sh[0].split('=',1)[1].split(',') if sh else SHAPES
    rid=time.strftime('%Y%m%d-%H%M%S')+'-'+label; outdir=os.path.join(RUNS,rid); os.makedirs(outdir,exist_ok=True)
    recs=[]
    for n in names:
        if not os.path.exists(os.path.join(HERE,'shapes','%s.py'%n)): continue
        mod=importlib.import_module(n)
        for vname,p in variants(mod,sweep):
            r=run_one(mod,vname,p,outdir); recs.append(r)
            print('%-12s %-22s %s %s'%(mod.NAME,vname,'PASS' if r['ok'] else 'FAIL', r.get('error') or (r.get('why') or '')), flush=True)
            json.dump(dict(runId=rid,records=recs),open(os.path.join(outdir,'results.json'),'w'),indent=1,default=str)
    # compare with the previous run
    prev=sorted(d for d in glob.glob(os.path.join(RUNS,'*')) if os.path.isdir(d) and d!=outdir and os.path.exists(os.path.join(d,'results.json')))
    cmp=[]
    if prev:
        old={(r['shape'],r['variant']):r for r in json.load(open(os.path.join(prev[-1],'results.json')))['records']}
        for r in recs:
            o=old.get((r['shape'],r['variant']))
            if o and o['ok']!=r['ok']: cmp.append(dict(shape=r['shape'],variant=r['variant'],was=o['ok'],now=r['ok']))
    summary=dict(runId=rid,previous=os.path.basename(prev[-1]) if prev else None,total=len(recs),passed=sum(r['ok'] for r in recs),changes=cmp)
    json.dump(dict(summary=summary,records=recs),open(os.path.join(outdir,'results.json'),'w'),indent=1,default=str)
    print(json.dumps(summary,indent=1))
if __name__=='__main__': main()
