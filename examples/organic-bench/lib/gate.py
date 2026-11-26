"""Continuity gate: evaluate a body against a per-edge plan.
Uses plasticity_check_continuity_plan when the server has it (feat/surface-consistency), else a local evaluator over
plasticity_continuity_report with the same rules: G0/G1 judged on all samples, G2 on the interior with a mixed
tolerance (relative OR absolute |k1-k2| <= absTol), 'flat across' labelled, never counted as a measured G2."""
from core import *
DEF=dict(normalAngleToleranceDeg=0.1, relativeCurvatureTolerance=0.05, positionToleranceMm=0.01, absoluteCurvatureTolerancePerMm=0.001)
def _edge_geom(body):
    return {e['id']:e for e in edges(body)}
def _match(sel, e, g):
    b=g['boundsMm']; v=g['verts']
    if 'edgeIds' in sel: return e['edgeId'] in sel['edgeIds']
    if 'zRing' in sel: return abs(b['min'][2]-sel['zRing'])<sel.get('tol',0.05) and abs(b['max'][2]-sel['zRing'])<sel.get('tol',0.05)
    if 'xPlaneEdge' in sel: return abs(b['min'][0]-sel['xPlaneEdge'])<sel.get('tol',0.05) and abs(b['max'][0]-sel['xPlaneEdge'])<sel.get('tol',0.05)
    if 'vertical' in sel: return (b['max'][0]-b['min'][0])<1e-3 and (b['max'][1]-b['min'][1])<1e-3 and (b['max'][2]-b['min'][2])>1
    if 'nearPointMm' in sel: return math.dist(g['centerMm'],sel['nearPointMm'])<sel.get('tol',1.0)
    if 'endsNearMm' in sel:
        a,c=sel['endsNearMm']; t=sel.get('tol',1.0)
        return len(v)==2 and ((math.dist(v[0],a)<t and math.dist(v[1],c)<t) or (math.dist(v[0],c)<t and math.dist(v[1],a)<t))
    if 'predicate' in sel: return sel['predicate'](e,g)
    return False
def evaluate(body, plan, defaults=None, report=None):
    d=dict(DEF); d.update(defaults or {})
    rep=report or C('plasticity_continuity_report',{'bodyId':body,'normalAngleToleranceDeg':d['normalAngleToleranceDeg'],'relativeCurvatureTolerance':d['relativeCurvatureTolerance'],'positionToleranceMm':d['positionToleranceMm']})
    geo=_edge_geom(body); rows=rep['edges']; used=set(); items=[]; first=None
    for it in plan:
        sel=it['select']
        m=[e for e in rows if e['edgeId'] not in used and (sel.get('rest') or _match(sel,e,geo[e['edgeId']]))]
        for e in m: used.add(e['edgeId'])
        tol=dict(d); tol.update({k:v for k,v in it.items() if k in DEF})
        out=[]
        for e in m:
            n=e['normalAngleDeg']; g2=e['relativeCurvature']; pos=e['positionMm']['max']
            # prefer the gate fields of the new server when present
            eff=e.get('effectiveInteriorClass'); g2s=(e.get('g2') or {}).get('status')
            if eff is None:
                ac=e.get('absoluteCurvature') or {}
                absdiff=abs(abs(ac.get('side1PerMm',1))-abs(ac.get('side2PerMm',0))) if ac else None
                g1ok=pos<=tol['positionToleranceMm'] and n['max']<=tol['normalAngleToleranceDeg']
                g2ok=g1ok and ((g2['interiorMax'] or 0)<=tol['relativeCurvatureTolerance'] or (absdiff is not None and absdiff<=tol['absoluteCurvatureTolerancePerMm'] and max(ac.get('side1PerMm',1),ac.get('side2PerMm',1))<=tol['absoluteCurvatureTolerancePerMm']))
                flat=g2ok and (g2['interiorMax'] or 0)>tol['relativeCurvatureTolerance']
                eff='G2' if g2ok else 'G1' if g1ok else ('G0' if pos<=tol['positionToleranceMm'] else 'none'); g2s='flat-across' if flat else 'measured'
            t=it['target']
            if t=='G2': ok=eff=='G2' and (g2s!='flat-across' or it.get('allowFlatAcross',True))
            elif t=='G1': ok=eff in('G1','G2')
            elif t=='G0': ok=eff in('G0','G1','G2')
            elif t=='sharp': ok=(n.get('interiorMean') or n['max'])>=1.0
            else: ok=True
            ach=eff+(' (not measurable: flat across)' if eff=='G2' and g2s=='flat-across' else '')
            r=dict(edgeId=e['edgeId'],achieved=ach,pass_=ok,normalDegMax=n['max'],normalDegInteriorMax=n['interiorMax'],relG2InteriorMax=g2['interiorMax'],absCurvature=e.get('absoluteCurvature'))
            out.append(r)
            if not ok and first is None: first=dict(item=it.get('name'),edgeId=e['edgeId'],target=t,achieved=ach)
        cnt_ok=('expectCount' not in it) or it['expectCount']==len(m)
        if not cnt_ok and first is None: first=dict(item=it.get('name'),edgeId=None,target=it['target'],achieved='matched %d edges, expected %d'%(len(m),it['expectCount']))
        items.append(dict(name=it.get('name'),target=it['target'],matched=len(m),countOk=cnt_ok,pass_=cnt_ok and all(r['pass_'] for r in out),edges=out))
    return dict(pass_=all(i['pass_'] for i in items),firstFailure=first,items=items,unmatched=len([e for e in rows if e['edgeId'] not in used]))

# ---------------------------------------------------------------- server-side gate (feat/surface-consistency)
_HAS_TOOL=None
def has_tool():
    global _HAS_TOOL
    if _HAS_TOOL is None:
        try: _HAS_TOOL=any(t['name']=='plasticity_check_continuity_plan' for t in call('plasticity_call',{'toolName':'catalog','query':'plasticity_check_continuity_plan'})['tools'])
        except Exception: _HAS_TOOL=False
    return _HAS_TOOL
def evaluate_tool(body, plan, defaults=None):
    """Resolve the bench selectors to edge ids locally, then let plasticity_check_continuity_plan judge them."""
    d=dict(DEF); d.update(defaults or {})
    rep=C('plasticity_continuity_report',{'bodyId':body,'normalAngleToleranceDeg':d['normalAngleToleranceDeg']})
    geo=_edge_geom(body); used=set(); items=[]; missing=[]
    for it in plan:
        sel=it['select']
        if sel.get('rest'):
            items.append(dict(name=it.get('name','rest'),select={'rest':True},target=it['target'])); continue
        ids=[e['edgeId'] for e in rep['edges'] if e['edgeId'] not in used and _match(sel,e,geo[e['edgeId']])]
        used.update(ids)
        if not ids:
            if it.get('expectCount',1)!=0: missing.append(it.get('name',''))
            continue
        x=dict(name=it.get('name',''),select={'edgeIds':ids},target=it['target'])
        if 'expectCount' in it: x['expectCount']=it['expectCount']
        for k in ('normalAngleToleranceDeg','relativeCurvatureTolerance','positionToleranceMm','allowFlatAcross','region'):
            if k in it: x[k]=it[k]
        items.append(x)
    items=[i for i in items if i['select'].get('edgeIds')!=['__none__']] if False else items
    r=C('plasticity_check_continuity_plan',{'bodyId':body,'plan':items,'defaults':{k:d[k] for k in DEF}})
    if missing: r['pass']=False; r['firstFailure']=r.get('firstFailure') or dict(item=missing[0],achieved='matched 0 edges')
    return dict(pass_=r['pass'],firstFailure=r.get('firstFailure'),missingItems=missing,items=[dict(name=i.get('name'),target=i.get('target'),matched=i.get('matched'),pass_=i.get('pass'),edges=[dict(edgeId=e['edgeId'],achieved=e.get('achieved'),pass_=e.get('pass'),normalDegInteriorMax=e.get('normalAngleDegInteriorMax'),relG2InteriorMax=e.get('relCurvatureInteriorMax'),g2Status=e.get('g2Status')) for e in i.get('edges',[])]) for i in r['items']],unmatched=r.get('unmatchedTwoFaceEdges'),seams=r.get('seamEdgesNotChecked'),source='plasticity_check_continuity_plan')
_evaluate_local=evaluate
def evaluate(body, plan, defaults=None, report=None):
    if has_tool(): return evaluate_tool(body, plan, defaults)
    r=_evaluate_local(body, plan, defaults, report); r['source']='local'; return r
