"""Minimal client for the Plasticity MCP daemon (bench/tools/daemon2.mjs). Port from env PLD_PORT."""
import json, os, urllib.request, math, time
ROOT=os.environ.get('ORGANIC_ROOT', os.path.expanduser('~/Desktop/organic-tutorial'))
PORT=int(os.environ.get('PLD_PORT','47721'))
def call(tool, args=None):
    req=urllib.request.Request('http://127.0.0.1:%d/'%PORT, data=json.dumps({'tool':tool,'args':args or {}}).encode(), headers={'content-type':'application/json'})
    r=json.load(urllib.request.urlopen(req, timeout=1800))
    if 'error' in r: raise RuntimeError(r['error'])
    txt=''.join(c['text'] for c in r.get('content',[]) if c.get('type')=='text')
    if r.get('isError'): raise RuntimeError(txt[:3000])
    try: return json.loads(txt)
    except Exception: return txt
def rev(): return call('plasticity_status')['revision']
def C(tool, args):
    """Route any registered tool (named or catalog-only) with the current revision."""
    a=dict(args); a.setdefault('revision', rev()); return call('plasticity_call',{'toolName':tool,'arguments':a})
def batch(steps, detail='standard', undoOnError=True):
    return call('plasticity_batch',{'steps':steps,'detail':detail,'undoOnError':undoOnError})
def added(r, typ=None):
    out=[]
    for s in r.get('steps',[]):
        for a in s.get('addedBodies',[]):
            if typ is None or a['type']==typ: out.append(a['id'])
    return out
def bodies(): return {x['id']:x for x in call('plasticity_status')['bodies']}
def delete(ids):
    ids=list(ids)
    if ids: call('plasticity_delete',{'ids':ids,'revision':rev()})
def wipe(): delete(bodies())
def wires(): return [i for i,x in bodies().items() if x['type']=='Wire']
def info(i): return call('plasticity_body_info',{'id':i})['body']
def edges(i, boundary=None):
    r=info(i); V={v['id']:v['positionMm'] for v in r['vertices']}; out=[]
    for e in r['edges']:
        n=len(e['faceIds'])
        if boundary is True and n!=1: continue
        if boundary is False and n!=2: continue
        e=dict(e); e['verts']=[V[v] for v in e['vertexIds']]; out.append(e)
    return out
def nearest_edge(i, p, boundary=None, tol=1.0, key='centerMm'):
    es=edges(i,boundary)
    m=min(es,key=lambda e: math.dist(e[key],p))
    if math.dist(m[key],p)>tol: raise RuntimeError('no edge near %s on body %s: nearest %s at %.3f'%(p,i,m['id'],math.dist(m[key],p)))
    return m
def edge_by_ends(i, a, b, boundary=None, tol=0.05):
    for e in edges(i,boundary):
        v=e['verts']
        if len(v)==2 and ((math.dist(v[0],a)<tol and math.dist(v[1],b)<tol) or (math.dist(v[0],b)<tol and math.dist(v[1],a)<tol)): return e
    raise RuntimeError('no edge with ends %s %s on %s'%(a,b,i))
def solids(): return [i for i,x in bodies().items() if x['type']=='Solid']
def save(path): call('plasticity_save_copy',{'path':path,'overwrite':True})
def open_doc(path, backup_dir):
    call('plasticity_open_document',{'path':path,'backupPath':os.path.join(backup_dir,'bk-%d.plasticity'%time.time_ns()),'revision':rev()})
