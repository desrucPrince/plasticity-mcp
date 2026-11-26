import json, urllib.request, sys
def call(tool, args=None):
    req = urllib.request.Request('http://127.0.0.1:47691/', data=json.dumps({'tool':tool,'args':args or {}}).encode(), headers={'content-type':'application/json'})
    r = json.load(urllib.request.urlopen(req, timeout=1800))
    if 'error' in r: raise RuntimeError(r['error'])
    txt = ''.join(c['text'] for c in r.get('content',[]) if c.get('type')=='text')
    if r.get('isError'): raise RuntimeError(txt[:1500])
    try: return json.loads(txt)
    except Exception: return txt
def rev(): return call('plasticity_status')['revision']
if __name__=='__main__':
    t=sys.argv[1]; a=json.loads(sys.argv[2]) if len(sys.argv)>2 else {}
    if 'revision' in a and a['revision']=='$': a['revision']=rev()
    print(json.dumps(call(t,a),indent=1)[:int(sys.argv[3]) if len(sys.argv)>3 else 6000])

def b(steps, detail='lean', undoOnError=True):
    return call('plasticity_batch', {'steps':steps,'detail':detail,'undoOnError':undoOnError})
def P(x): print(json.dumps(x,indent=None)[:4000])

def schema(n):
    r=call('plasticity_call',{'toolName':'catalog','query':n})
    t=r['tools'][0]; return t['description'], t['inputSchema']
