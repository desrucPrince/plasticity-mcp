"""Shape 4: the desk speaker, consistency recipe.
Half body (x >= 0) from untrimmed four-sided lofts, mirrored at x = 0:
  face   planar stadium (G2 cap bridges), front, details added at the end
  flank  loft: face straight edge -> base side line, guides front/rear (as attempt 3)
  shell  ONE loft (the old side + back + band): profiles = flank rear EDGE (clamped -> G2 to flank),
         section templates (positional), centre support EDGE (clamped -> perpendicular to x = 0);
         guides = face top cap edge, base outline rear
  wrap   ONE loft: flank front EDGE (clamped) -> front centre support EDGE (clamped);
         guides = face bottom cap edge, base outline front
  base   planar cap of the bottom hole (sharp, hidden), plinth ring, face rim/panel, camera recess
The old trimmed Indie patches (side, back, wrap) are gone, and with them the side/back join."""
from blocks import *
import json, os
NAME='s4_speaker'
TEMPL=ROOT+'/bench/shapes/s4_templates.json'
Q_A3B=[[23.374,134.877],[32.509454575999996,130.809633569],[41.644909152,126.74226713800002],[49.47360126124659,119.98905262332184],[54.25392573181449,110.0399134859098],[54.36029674341374,97.69214214284248],[48.16562767518579,85.14989625309555],[33.822514641890336,73.90865140125285],[28.153678434603986,62.401263578076595],[32.801465390310355,40.70187984488938],[36.66848429386521,22.561898337520116],[47.36468879990559,9.031063321597413],[56.0,4.0]]
WRAP_A3=[[0,-50,34],[0,-48.9,24],[0,-49.3,14],[0,-52.4,7],[0,-56,4]]
DEFAULT=dict(faceW=84.0, faceLen=122.0, tiltDeg=24.0, baseHW=49.5, baseHD=56.0, band=26.0, zb=4.0, capT=-6.72, details=1.0)
NO_SWEEP=('zb','capT','details','band')
SWEEP={'tiltDeg':(-3,3)}
def vec(a,b,s=1): return [a[i]+s*b[i] for i in range(3)]
def frame(p):
    t=math.radians(p['tiltDeg'])
    n=[0,-math.cos(t),math.sin(t)]; u=[0,math.sin(t),math.cos(t)]; m=[-c for c in n]
    O=[0,-50,34]
    L=p['faceLen']-p['faceW']; r=p['faceW']/2
    c1=vec([r,-50,34],u,r); c2=vec([r,-50,34],u,r+L); top=vec(O,u,p['faceLen'])
    return dict(n=n,u=u,m=m,O=O,c1=c1,c2=c2,top=top,r=r,L=L)
def build_face(p,F):
    r,L=F['r'],F['L']; h=L/2
    S=added(batch([{'toolName':'plasticity_create_rectangle','arguments':{'centerMm':[0,0,0],'widthMm':2*r,'heightMm':L,'normal':[0,0,1],'xDirection':[1,0,0],'angleDegrees':0}},
                   {'toolName':'plasticity_patch_closed_wires','arguments':{'ids':['$0.added[0]']}}]),'Sheet')[0]
    for yy in (h,-h):
        es=edges(S); R=min(es,key=lambda e:math.dist(e['centerMm'],[r,0,0])); Lf=min(es,key=lambda e:math.dist(e['centerMm'],[-r,0,0]))
        Te=min(es,key=lambda e:math.dist(e['centerMm'],[0,yy,0]))
        vr=[i for i,v in zip(info(S)['edges'][0:0] or [],[])]  # placeholder
        def vid(e,pt):
            bi=info(S); V={v['id']:v['positionMm'] for v in bi['vertices']}; ee=[x for x in bi['edges'] if x['id']==e['id']][0]
            return min(ee['vertexIds'],key=lambda v:math.dist(V[v],pt))
        batch([{'toolName':'plasticity_bridge_shell_edges','arguments':{'first':{'bodyId':S,'edgeId':R['id'],'vertexId':vid(R,[r,yy,0]),'tensionG1Mm':p['capT']},'second':{'bodyId':S,'edgeId':Lf['id'],'vertexId':vid(Lf,[-r,yy,0]),'tensionG1Mm':p['capT']},'startContinuity':'G2','endContinuity':'G2'}},
               {'toolName':'plasticity_patch_sheet_hole','arguments':{'id':S,'edgeIds':[Te['id']],'curveIds':['$0.added[0]'],'continuity':'g2'}}])
    inner=[e for e in edges(S,False)]
    batch([{'toolName':'plasticity_delete_edges','arguments':{'edges':[{'bodyId':S,'edgeId':e['id']} for e in inner]}}])
    delete(wires())
    t=p['tiltDeg']; c=math.cos(math.radians(90-t)); s=math.sin(math.radians(90-t))
    mid=p['faceLen']/2
    batch([{'toolName':'plasticity_rotate','arguments':{'ids':[S],'pivotMm':[0,0,0],'axis':[1,0,0],'degrees':90-t}},
           {'toolName':'plasticity_move','arguments':{'ids':[S],'deltaMm':[0,-50+mid*c,34+mid*s]}}])
    return S
def build_outline(p):
    ZB,hw,hd=p['zb'],p['baseHW'],p['baseHD']; fx=11.5*hd/56; sy=18.0*hd/56
    pl=lambda a,b:{'toolName':'plasticity_create_polyline','arguments':{'pointsMm':[a+[ZB],b+[ZB]],'closed':False}}
    ids=added(batch([pl([0,-hd],[fx,-hd]), pl([hw,-sy],[hw,0]), pl([hw,0],[hw,sy]), pl([fx,hd],[0,hd])]))
    l1,l2,l3,l4=ids
    b1=bridge_g2(l1,l2); b2=bridge_g2(l3,l4)
    return dict(front=[l1,b1,l2], side=[], rear=[l3,b2,l4])
def cut_half(ids):
    w=added(batch([{'toolName':'plasticity_create_polyline','arguments':{'pointsMm':[[0,-300,-50],[0,300,-50]],'closed':False}}]))[0]
    batch([{'toolName':'plasticity_cut_with_curves','arguments':{'targetIds':list(ids),'curveIds':[w],'direction':[0,0,1],'extend':True,'keep':'both'}}])
    delete([w])
    for i,x in list(bodies().items()):
        if x['type']=='Sheet' and x['boundsMm']['max'][0]<1e-6: delete([i])
def extract(body, e):
    return added(batch([{'toolName':'plasticity_extract_edges','arguments':{'edges':[{'bodyId':body,'edgeId':e['id']}]}}]))[0]
def guide_from_edge(body, a, b):
    """Wire copy of the boundary edge of body running from a to b."""
    return extract(body, edge_by_ends(body,a,b,True,tol=0.05))
def build_flank(p,F,face,base_side_wire):
    ZB,hw,sy=p['zb'],p['baseHW'],18.0*p['baseHD']/56
    c1,c2=F['c1'],F['c2']
    straight=edge_by_ends(face,c1,c2,True,tol=0.05)
    fw=extract(face,straight)
    end=[hw,-sy,ZB]
    # front guide: attempt-3 control points, as offsets from the chord c1 -> end
    FG0=[[41.7,-30.2,54],[42.4,-25.8,27],[45.4,-22.2,10]]; c10=[42,-50+42*math.sin(math.radians(24)),34+42*math.cos(math.radians(24))]; e0=[49.5,-18,4]
    FG=[c1]+[[q[i]-c10[i]-(e0[i]-c10[i])*k/4+(end[i]-c1[i])*k/4+c1[i] for i in range(3)] for k,q in zip((1,2,3),FG0)]+[end]
    fg=cp_curve(FG)
    uy,uz=0-c2[1],ZB-c2[2]; nrm=math.hypot(uy,uz); xo=hw-c2[0]
    pts=[[0,0],[12,0],[24,0],[58,0.6],[84,2.4],[97,5.2],[119.0,7.5]]
    pts=[[a*nrm/119.0,b*xo/7.5] for a,b in pts]; pts[-1]=[nrm,xo]
    rg=plane_curve({'originMm':c2,'uAxis':[0,uy/nrm,uz/nrm],'vAxis':[1,0,0]},pts,startTangent={'direction':[1,0]},startCurvatureZero=True)
    fl=g2_loft([fw,base_side_wire],guides=[fg,rg],curvature='unconstrained')
    delete([fw,fg,rg])
    return fl
def stage1(p):
    F=frame(p)
    face=build_face(p,F)
    ol=build_outline(p)
    cut_half([face])
    face=[i for i,x in bodies().items() if x['type']=='Sheet'][0]
    side=ol['front'][2]  # l2: (hw,-sy)->(hw,0)
    fl=build_flank(p,F,face,side)
    return F,face,ol,fl
# ---------------------------------------------------------------- guides and section templates
def wire_poly(wire, n=60):
    s=segments()[wire]['segments']
    pts=[]
    for k,sg in enumerate(s):
        smp=call('plasticity_evaluate_curve_segments',{'samples':[{'bodyId':wire,'segmentEntityId':sg['entityId'],'normalizedParameter':i/n} for i in range(n+1)],'revision':rev()})['samples']
        q=[x['positionMm'] for x in smp]
        if pts and math.dist(pts[-1],q[-1])<math.dist(pts[-1],q[0]): q=q[::-1]
        if pts and math.dist(pts[-1],q[0])>0.01 and k==1 and math.dist(pts[0],q[0])<0.01: pts=pts[::-1]
        pts+= q if not pts else q[1:]
    return pts
def at_fraction(poly, s):
    L=[0.0]
    for a,b in zip(poly,poly[1:]): L.append(L[-1]+math.dist(a,b))
    x=s*L[-1]
    for i in range(1,len(L)):
        if L[i]>=x:
            f=(x-L[i-1])/max(L[i]-L[i-1],1e-12); return [poly[i-1][j]+f*(poly[i][j]-poly[i-1][j]) for j in range(3)]
    return poly[-1]
def orient(poly, start):
    return poly if math.dist(poly[0],start)<math.dist(poly[-1],start) else poly[::-1]
def unitv(v): l=math.sqrt(sum(c*c for c in v)); return [c/l for c in v]
def dot(a,b): return sum(x*y for x,y in zip(a,b))
def cross(a,b): return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
def section_frame(top, bot, s, inside=(0,15,70)):
    T=at_fraction(top,s); Bp=at_fraction(bot,s); d=0.01
    a=[at_fraction(top,min(1,s+d))[i]-at_fraction(top,max(0,s-d))[i]+at_fraction(bot,min(1,s+d))[i]-at_fraction(bot,max(0,s-d))[i] for i in range(3)]
    c=[Bp[i]-T[i] for i in range(3)]; cl=math.sqrt(dot(c,c)); ch=[x/cl for x in c]
    a=unitv([a[i]-dot(a,ch)*ch[i] for i in range(3)])
    o=unitv(cross(ch,a))
    M=[(T[i]+Bp[i])/2 for i in range(3)]
    if dot(o,[M[i]-inside[i] for i in range(3)])<0: o=[-x for x in o]
    return T,Bp,ch,cl,o,a
def make_templates(top, bot, body, fracs, inside):
    out=[]
    for s in fracs:
        T,Bp,ch,cl,o,a=section_frame(top,bot,s,inside)
        M=[(T[i]+Bp[i])/2 for i in range(3)]; I=[M[i]-o[i]*0.35*cl for i in range(3)]
        e1=ch; e2=o
        ang=lambda P: math.atan2(dot([P[i]-I[i] for i in range(3)],e2),dot([P[i]-I[i] for i in range(3)],e1))
        aT,aB=ang(T),ang(Bp)
        rays=[]; N=24
        for k in range(1,N):
            ph=aT+(aB-aT)*k/N
            rays.append({'originMm':I,'direction':[math.cos(ph)*e1[i]+math.sin(ph)*e2[i] for i in range(3)]})
        pr=call('plasticity_probe_surface',{'id':body,'rays':rays,'revision':rev()})
        pts=[]
        for r_ in pr['rays']:
            if r_['intersections']:
                P=r_['intersections'][0]['pointMm']; v=[P[i]-T[i] for i in range(3)]
                pts.append([dot(v,ch)/cl, dot(v,o)/cl, dot(v,a)/cl])
        out.append(dict(s=s,points=pts))
    return out
def apply_template(top, bot, tpl, inside, exact=None):
    T,Bp,ch,cl,o,a=section_frame(top,bot,tpl['s'],inside)
    if exact:  # snap the section ends onto the real guide curves
        T=exact_at(exact[0],exact[1],tpl['s']); Bp=exact_at(exact[2],exact[3],tpl['s'])
        c=[Bp[i]-T[i] for i in range(3)]; cl=math.sqrt(dot(c,c)); ch=[x/cl for x in c]
        o=unitv([o[i]-dot(o,ch)*ch[i] for i in range(3)])
    pts=[[0,0]]+[[t*cl,h*cl] for t,h,_ in tpl['points'] if 0.03<t<0.97]+[[cl,0]]
    import bspline
    ctrl,err=bspline.fit(pts,NCTRL)
    FITLOG.append(dict(s=tpl['s'],fitErrMm=round(err,3)))
    return plane_curve({'originMm':T,'uAxis':ch,'vAxis':o},ctrl,mode='control')
INSIDE_SHELL=(0,15,70); INSIDE_WRAP=(0,-30,30)
NCTRL=6; FITLOG=[]; SHELL_S=(0.33,0.67); USE_FAMILY=False; FAMFIT='chord'; LOFTKW={}; TMIN=0.03; BANDCUT=0.0; FACEPLANE=None; BANDCUT_MM=26.0
TPL=json.load(open(TEMPL)) if os.path.exists(TEMPL) else None
def sim2(P0,E0,P,E,q):
    """2D similarity that maps P0->P, E0->E, applied to q."""
    a=complex(*P0); b=complex(*E0); A=complex(*P); Bc=complex(*E); z=complex(*q)
    w=A+(z-a)*(Bc-A)/(b-a); return [w.real,w.imag]
def centre_profile(p,F):
    """yz control polygon: straight band (top -> Tb along -n), then the attempt-3 back profile, mapped to the new chord."""
    m=F['m']; top=F['top']; Tb=vec(top,m,p['band'] if p['band']>1e-6 else 26.0)
    Q=[sim2(Q_A3B[0],Q_A3B[-1],[Tb[1],Tb[2]],[p['baseHD'],p['zb']],q) for q in Q_A3B]
    d1=math.dist(Q_A3B[0],Q_A3B[1]); d2=math.dist(Q_A3B[0],Q_A3B[2])
    Q[1]=[Tb[1]+m[1]*d1,Tb[2]+m[2]*d1]; Q[2]=[Tb[1]+m[1]*d2,Tb[2]+m[2]*d2]
    head=[[top[1]+m[1]*p['band']*k/3,top[2]+m[2]*p['band']*k/3] for k in range(3)]
    if p['band']<=1e-6:  # no band: the head profile starts at the face top, leaving it along -n
        Q[0]=[top[1],top[2]]; Q[1]=[top[1]+m[1]*d1,top[2]+m[2]*d1]; Q[2]=[top[1]+m[1]*d2,top[2]+m[2]*d2]
        return Q
    return head+Q
def front_profile(p,F):
    O=F['O']; G=[sim2([-50,34],[-56,4],[O[1],O[2]],[-p['baseHD'],p['zb']],[q[1],q[2]]) for q in WRAP_A3]
    return G
def support(yz_pts):
    w=plane_curve('yz',yz_pts)
    S=extrude(w,10,(-1,0,0)); delete([w]); return S
def x0_edge(S):
    return [e for e in edges(S,True) if all(abs(v[0])<1e-6 for v in e['verts']) and e['boundsMm']['max'][0]-e['boundsMm']['min'][0]<1e-6 and e['lengthMm']>20][0]
def build_shell(p,F,face,ol,fl):
    topw=guide_from_edge(face,F['c2'],F['top'])
    botw=join_curves(ol['rear'])[0]
    top=orient(wire_poly(topw),F['c2']); bot=orient(wire_poly(botw),[p['baseHW'],0,p['zb']])
    ex=(topw,oriented_chain(topw,F['c2']),botw,oriented_chain(botw,[p['baseHW'],0,p['zb']]))
    mids=[apply_template(top,bot,t,INSIDE_SHELL,ex) for t in TPL['shell'] if round(t['s'],2) in SHELL_S]
    sup=support(centre_profile(p,F))
    fe=edge_by_ends(fl,F['c2'],[p['baseHW'],0,p['zb']],True,tol=0.05)
    se=x0_edge(sup)
    sh=g2_loft([(fl,fe['id'])]+mids+[(sup,se['id'])],guides=[topw,botw])
    delete(mids+[topw,botw])
    return sh,sup
def build_wrap(p,F,face,ol,fl):
    sy=18.0*p['baseHD']/56
    topw=guide_from_edge(face,F['c1'],F['O'])
    botw=join_curves([ol['front'][0],ol['front'][1]])[0]
    top=orient(wire_poly(topw),F['c1']); bot=orient(wire_poly(botw),[p['baseHW'],-sy,p['zb']])
    ex=(topw,oriented_chain(topw,F['c1']),botw,oriented_chain(botw,[p['baseHW'],-sy,p['zb']]))
    mids=[apply_template(top,bot,t,INSIDE_WRAP,ex) for t in TPL['wrap']]
    sup=support(front_profile(p,F))
    fe=edge_by_ends(fl,F['c1'],[p['baseHW'],-sy,p['zb']],True,tol=0.05)
    se=x0_edge(sup)
    wr=g2_loft([(fl,fe['id'])]+mids+[(sup,se['id'])],guides=[topw,botw])
    delete(mids+[topw,botw])
    return wr,sup
def wire_param_poly(wire, n=60):
    """[(point, segEntityId, param)] along the whole wire in order."""
    s=segments()[wire]['segments']; chain=[]
    for sg in s:
        smp=call('plasticity_evaluate_curve_segments',{'samples':[{'bodyId':wire,'segmentEntityId':sg['entityId'],'normalizedParameter':i/n} for i in range(n+1)],'revision':rev()})['samples']
        chain.append([(x['positionMm'],sg['entityId'],i/n) for i,x in enumerate(smp)])
    out=chain[0]
    for q in chain[1:]:
        if math.dist(out[-1][0],q[0][0])>0.01 and math.dist(out[-1][0],q[-1][0])<0.01: q=q[::-1]
        elif math.dist(out[0][0],q[0][0])<0.01 or math.dist(out[0][0],q[-1][0])<0.01:
            out=out[::-1]
            if math.dist(out[-1][0],q[-1][0])<0.01: q=q[::-1]
        out+=q[1:]
    return out
def exact_at(wire, chain, s):
    L=[0.0]
    for a,b in zip(chain,chain[1:]): L.append(L[-1]+math.dist(a[0],b[0]))
    x=s*L[-1]
    for i in range(1,len(L)):
        if L[i]>=x:
            a,b=chain[i-1],chain[i]
            if a[1]!=b[1]: return b[0]
            f=(x-L[i-1])/max(L[i]-L[i-1],1e-12); t=a[2]+f*(b[2]-a[2])
            return call('plasticity_evaluate_curve_segments',{'samples':[{'bodyId':wire,'segmentEntityId':a[1],'normalizedParameter':t}],'revision':rev()})['samples'][0]['positionMm']
    return chain[-1][0]
def oriented_chain(wire, start):
    c=wire_param_poly(wire); return c if math.dist(c[0][0],start)<math.dist(c[-1][0],start) else c[::-1]
def build_details(p,F,BODY):
    """Face rim + recessed panel, camera recess, plinth ring (as attempt 3)."""
    n=F['n']; m=F['m']; u=F['u']
    if not p.get('details'): return BODY
    fs=call('plasticity_find_faces',{'revision':rev(),'query':{'bodyIds':[BODY]},'limit':80})['matches']
    fh=[f['id'] for f in fs if f['planar'] and abs(dot(f['normal'],n)-1)<1e-4]
    call('plasticity_inset_planar_face',{'bodyId':BODY,'faceIds':fh,'distanceMm':2,'depthMm':1.5,'revision':rev()})
    cc=vec(F['O'],u,87*p['faceLen']/122)
    cyl=added(batch([{'toolName':'plasticity_create_cylinder','arguments':{'centerMm':vec(cc,n,1.0),'radiusMm':13,'heightMm':6.5,'axis':m}}]),'Solid')[0]
    batch([{'toolName':'plasticity_boolean','arguments':{'targetIds':[BODY],'toolIds':[cyl],'operation':'difference','keepTools':False}}])
    return BODY
def plinth(p, ring_wire, BODY):
    r=batch([{'toolName':'plasticity_offset_planar_curves','arguments':{'ids':[ring_wire],'distanceMm':1.0}},
             {'toolName':'plasticity_move','arguments':{'ids':['$0.added[0]'],'deltaMm':[0,0,-p['zb']]}},
             {'toolName':'plasticity_extrude_profile','arguments':{'id':'$0.added[0]','distanceMm':p['zb']}}])
    pl=added(r,'Solid')[0]
    batch([{'toolName':'plasticity_boolean','arguments':{'targetIds':[BODY],'toolIds':[pl],'operation':'union','keepTools':False}}])
def build(p):
    F,face,ol,fl=stage1(p)
    sh,sup=build_shell(p,F,face,ol,fl)
    wr,sup2=build_wrap(p,F,face,ol,fl)
    delete([sup,sup2]+wires())
    H=join([face,fl,sh,wr])
    S=mirror_join(H)
    bot=[e['id'] for e in edges(S,True) if abs(e['boundsMm']['min'][2]-p['zb'])<1e-3 and abs(e['boundsMm']['max'][2]-p['zb'])<1e-3]
    planar_cap(S,bot)
    S=[i for i,x in bodies().items() if x['type'] in ('Solid','Sheet')][0]
    if bodies()[S]['type']!='Solid': raise RuntimeError('half shell did not close: %s'%bodies()[S])
    if p.get('details'):
        # ring wire = the base outline, rebuilt full (both halves) for the plinth
        ring=full_outline(p)
        build_details(p,F,S); plinth(p,ring,S)
        delete([i for i in bodies() if i!=S])
    return S
def full_outline(p):
    ZB,hw,hd=p['zb'],p['baseHW'],p['baseHD']; fx=11.5*hd/56; sy=18.0*hd/56
    pl=lambda a,b:{'toolName':'plasticity_create_polyline','arguments':{'pointsMm':[a+[ZB],b+[ZB]],'closed':False}}
    l=added(batch([pl([-fx,-hd],[fx,-hd]), pl([hw,-sy],[hw,sy]), pl([fx,hd],[-fx,hd]), pl([-hw,sy],[-hw,-sy])]))
    br=[bridge_g2(l[i],l[(i+1)%4]) for i in range(4)]
    return join_curves(l+br)[0]
REF=ROOT+'/bench/shapes/s4_reference_dims.json'
def silhouette(body, xs=(0,10,25,35), zs=None):
    zs=zs or list(range(6,146,2)); out={}
    for x in xs:
        o=[]
        for i in range(0,len(zs),60):
            pr=call('plasticity_probe_surface',{'id':body,'rays':[{'originMm':[x+0.01,300,z],'direction':[0,-1,0]} for z in zs[i:i+60]],'revision':rev()})
            o+=[(r_['originMm'][2], r_['intersections'][0]['pointMm'][1] if r_['intersections'] else None) for r_ in pr['rays']]
        d=[(z,y) for z,y in o if y is not None]
        hd=max([t for t in d if t[0]>90],key=lambda t:t[1]); nk=min([t for t in d if 30<t[0]<90],key=lambda t:t[1])
        out[str(x)]=dict(headY=hd[1],headZ=hd[0],neckY=nk[1],neckZ=nk[0],pinch=hd[1]-nk[1],profile=d)
    return out
def side_profile(body, ys=(-10,0,10,20,30), zs=(20,40,60,80)):
    """x of the side surface at fixed (y, z): rays from +x."""
    rays=[{'originMm':[300,y,z],'direction':[-1,0,0]} for y in ys for z in zs]
    pr=call('plasticity_probe_surface',{'id':body,'rays':rays,'revision':rev()})
    return {'%d,%d'%(r_['originMm'][1],r_['originMm'][2]):(r_['intersections'][0]['pointMm'][0] if r_['intersections'] else None) for r_ in pr['rays']}
def dims(p, body):
    s=silhouette(body); sp=side_profile(body)
    out=dict(sil={k:{kk:v[kk] for kk in ('headY','headZ','neckY','neckZ','pinch')} for k,v in s.items()},side=sp)
    if os.path.exists(REF) and all(p[k]==DEFAULT[k] for k in DEFAULT):
        ref=json.load(open(REF)); dev={}
        for x,v in s.items():
            rp=dict((round(z),y) for z,y in ref['sil'][x]['profile']); dev['x=%s'%x]=max(abs(y-rp[round(z)]) for z,y in v['profile'] if round(z) in rp)
        for k,v in sp.items():
            if v is not None and ref['side'].get(k) is not None: dev['side '+k]=abs(v-ref['side'][k])
        out['maxDeviationFromAttempt3Mm']=dev; out['worstMm']=max(dev.values()); out['ok']=out['worstMm']<=1.0
    return out
def fairness(body, zs=(15,30,45,60,75,90,105,120), n=46):
    """Horizontal sections of the right half (x >= 0) seen from an inside axis; counts curvature sign changes
    (inflections) per section, ignoring curvature below 0.002 /mm. A fair organic shell has 0-1 per section."""
    out={}
    for z in zs:
        c=(0,8,z); rays=[{'originMm':list(c),'direction':[math.cos(math.radians(a)),math.sin(math.radians(a)),0]} for a in [-80+160*i/(n-1) for i in range(n)]]
        pr=call('plasticity_probe_surface',{'id':body,'rays':rays,'revision':rev()})
        P=[r_['intersections'][0]['pointMm'] for r_ in pr['rays'] if r_['intersections']]
        ks=[]
        for a,b_,c_ in zip(P,P[1:],P[2:]):
            ab=[b_[i]-a[i] for i in range(2)]; bc=[c_[i]-b_[i] for i in range(2)]
            cr=ab[0]*bc[1]-ab[1]*bc[0]; la=math.hypot(*ab); lb=math.hypot(*bc); lc=math.hypot(c_[0]-a[0],c_[1]-a[1])
            ks.append(2*cr/max(la*lb*lc,1e-9))
        sig=[k for k in ks if abs(k)>0.002]
        out[str(z)]=sum(1 for a,b_ in zip(sig,sig[1:]) if a*b_<0)
    return out
# ---------------------------------------------------------------- v2: symmetric through-lofts (no centre seam)
def mirror_copy(ids):
    r=batch([{'toolName':'plasticity_mirror','arguments':{'ids':list(ids),'planeOriginMm':[0,0,0],'planeNormal':[1,0,0],'keepOriginal':True}}])
    return added(r)
def build_v2(p):
    global FACEPLANE, BANDCUT
    F=frame(p); ZB,hw,hd=p['zb'],p['baseHW'],p['baseHD']; sy=18.0*hd/56; fx=11.5*hd/56
    FACEPLANE=(F['O'],F['n']); BANDCUT=BANDCUT_MM if p['band']<=1e-6 else 0.0
    mx=lambda q:[-q[0],q[1],q[2]]
    face=build_face(p,F)
    pl=lambda a,b:added(batch([{'toolName':'plasticity_create_polyline','arguments':{'pointsMm':[a+[ZB],b+[ZB]],'closed':False}}]))[0]
    sideR=pl([hw,-sy],[hw,0]); sideL=pl([-hw,-sy],[-hw,0])
    flR=build_flank(p,F,face,sideR)
    flL=mirror_copy([flR])[0]
    # guides
    topw=guide_from_edge(face,F['c2'],mx(F['c2'])); wtopw=guide_from_edge(face,F['c1'],mx(F['c1']))
    l3R=pl([hw,0],[hw,sy]); l4=pl([fx,hd],[-fx,hd]); l3L=pl([-hw,sy],[-hw,0])
    botw=join_curves([l3R,bridge_g2(l3R,l4),l4,bridge_g2(l4,l3L),l3L])[0]
    l1=pl([fx,-hd],[-fx,-hd])
    wbotw=join_curves([bridge_g2(sideR,l1),l1,bridge_g2(l1,sideL)])
    wbotw=[w for w in wbotw if w not in (sideR,sideL)][0]
    delete([sideR,sideL])
    # sections: right half from templates (s in 0..1 over the half guide), centre profile, mirrored left half
    def half_sections(topw,botw,startT,startB,tpls,inside):
        ct=oriented_chain(topw,startT); cb=oriented_chain(botw,startB)
        top=[c[0] for c in ct]; bot=[c[0] for c in cb]
        # half polylines up to the middle (x = 0)
        ht=[q for q in top if q[0]>=-1e-6]; hb=[q for q in bot if q[0]>=-1e-6]
        out=[]
        for t in tpls:
            T=exact_at(topw,ct,t['s']*0.5); Bq=exact_at(botw,cb,t['s']*0.5)
            if USE_FAMILY and inside==INSIDE_SHELL:
                _,_,_,_,o,_=section_frame(ht,hb,t['s'],inside); out.append(family_section(FAM,t['s'],T,Bq,o))
            else: out.append(apply_template_at(ht,hb,t,inside,T,Bq))
        return [r for r,l in out],[l for r,l in out]
    shell_t=[dict(s=x) for x in SHELL_S] if USE_FAMILY else [t for t in TPL['shell'] if round(t['s'],2) in SHELL_S]
    cen=plane_curve('yz',centre_profile(p,F))
    if DESIGN['on']:
        ct=oriented_chain(topw,F['c2']); cb=oriented_chain(botw,[hw,0,ZB])
        ht=[q[0] for q in ct if q[0][0]>=-1e-6]; hb=[q[0] for q in cb if q[0][0]>=-1e-6]
        midsR,midsL=design_sections(p,F,topw,botw,ct,cb,ht,hb,flR,cen)
    else:
        midsR,midsL=half_sections(topw,botw,F['c2'],[hw,0,ZB],shell_t,INSIDE_SHELL)
    fe=edge_by_ends(flR,F['c2'],[hw,0,ZB],True,tol=0.05); fl_e=edge_by_ends(flL,mx(F['c2']),[-hw,0,ZB],True,tol=0.05)
    shell=g2_loft([(flR,fe['id'])]+midsR+[cen]+midsL[::-1]+[(flL,fl_e['id'])],guides=[topw,botw],**LOFTKW)
    wR,wL=half_sections(wtopw,wbotw,F['c1'],[hw,-sy,ZB],TPL['wrap'],INSIDE_WRAP)
    wcen=plane_curve('yz',front_profile(p,F))
    fe=edge_by_ends(flR,F['c1'],[hw,-sy,ZB],True,tol=0.05); fl_e=edge_by_ends(flL,mx(F['c1']),[-hw,-sy,ZB],True,tol=0.05)
    wrap=g2_loft([(flR,fe['id'])]+wR+[wcen]+wL[::-1]+[(flL,fl_e['id'])],guides=[wtopw,wbotw])
    delete(wires())
    S=join([face,flR,flL,shell,wrap])
    bot=[e['id'] for e in edges(S,True) if abs(e['boundsMm']['min'][2]-ZB)<1e-3 and abs(e['boundsMm']['max'][2]-ZB)<1e-3]
    planar_cap(S,bot)
    S=[i for i,x in bodies().items() if x['type'] in ('Solid','Sheet')][0]
    if bodies()[S]['type']!='Solid': raise RuntimeError('shell did not close: %s'%bodies()[S])
    if p.get('details'):
        ring=full_outline(p); build_details(p,F,S); plinth(p,ring,S); delete([i for i in bodies() if i!=S])
    return S
def apply_template_at(top, bot, tpl, inside, T, Bp):
    _,_,ch,cl,o,a=section_frame(top,bot,tpl['s'],inside)
    c=[Bp[i]-T[i] for i in range(3)]; cl=math.sqrt(dot(c,c)); ch=[x/cl for x in c]
    o=unitv([o[i]-dot(o,ch)*ch[i] for i in range(3)])
    def depth(t,h):
        P=[T[i]+t*c[i]+h*cl*o[i] for i in range(3)]
        return -dot([P[i]-FACEPLANE[0][i] for i in range(3)],FACEPLANE[1])
    pts=[[0,0]]+[[t*cl,h*cl] for t,h,_ in tpl['points'] if 0.03<t<0.97 and (BANDCUT<=0 or inside!=INSIDE_SHELL or depth(t,h)>=BANDCUT)]+[[cl,0]]
    FITLOG.append(dict(s=tpl['s'],kept=len(pts),depths=[round(depth(t,h),1) for t,h,_ in tpl['points']][:6]))
    import bspline
    mx=lambda q:[-q[0],q[1],q[2]]
    if NCTRL==0:
        R=plane_curve({'originMm':T,'uAxis':ch,'vAxis':o},pts,mode='interpolate')
        L=plane_curve({'originMm':mx(T),'uAxis':mx(ch),'vAxis':mx(o)},pts,mode='interpolate')
        return R,L
    ctrl,err=bspline.fit(pts,NCTRL); FITLOG.append(dict(s=tpl['s'],fitErrMm=round(err,3)))
    R=plane_curve({'originMm':T,'uAxis':ch,'vAxis':o},ctrl,mode='control')
    L=plane_curve({'originMm':mx(T),'uAxis':mx(ch),'vAxis':mx(o)},ctrl,mode='control')
    return R,L
# ---------------------------------------------------------------- v3: a smooth section family h(s, t)
FAMILY=ROOT+'/bench/shapes/s4_family.json'
TGRID=[i/40 for i in range(41)]
def make_family(sections, deg=3):
    """sections: [{s, points:[[t,h,_]...]}] probed on attempt 3. Returns per-t polynomial coefficients in s."""
    import numpy as np
    S=[]; H=[]
    for sec in sections:
        P=sorted((q[0],q[1]) for q in sec['points'])
        tt=[0.0]+[a for a,_ in P]+[1.0]; hh=[0.0]+[b for _,b in P]+[0.0]
        S.append(sec['s']); H.append(np.interp(TGRID,tt,hh))
    H=np.array(H); coef=[np.polyfit(S,H[:,j],deg).tolist() for j in range(len(TGRID))]
    resid=float(np.max(np.abs(np.array([[np.polyval(coef[j],s_) for j in range(len(TGRID))] for s_ in S])-H)))
    return dict(tgrid=TGRID,coef=coef,deg=deg,maxResidualChord=resid,s=S)
def family_h(fam, s_):
    import numpy as np
    return [float(np.polyval(c,s_)) for c in fam['coef']]
def family_section(fam, s_, T, Bp, o_hint):
    c=[Bp[i]-T[i] for i in range(3)]; cl=math.sqrt(dot(c,c)); ch=[x/cl for x in c]
    o=unitv([o_hint[i]-dot(o_hint,ch)*ch[i] for i in range(3)])
    h=family_h(fam,s_); h[0]=0.0; h[-1]=0.0
    import bspline
    pts=[[t*cl,hh*cl] for t,hh in zip(fam['tgrid'],h)]
    ctrl,err=bspline.fit(pts,NCTRL) if FAMFIT=='chord' else bspline.fit_param(fam['tgrid'],pts,NCTRL)
    FITLOG.append(dict(s=s_,fitErrMm=round(err,3)))
    mx=lambda q:[-q[0],q[1],q[2]]
    R=plane_curve({'originMm':T,'uAxis':ch,'vAxis':o},ctrl,mode='control')
    L=plane_curve({'originMm':mx(T),'uAxis':mx(ch),'vAxis':mx(o)},ctrl,mode='control')
    return R,L
FAM=json.load(open(FAMILY)) if os.path.exists(FAMILY) else None
def fairness_detail(body, z, n=46, thr=0.002, center=(0,8)):
    rays=[{'originMm':[center[0],center[1],z],'direction':[math.cos(math.radians(a)),math.sin(math.radians(a)),0]} for a in [-80+160*i/(n-1) for i in range(n)]]
    pr=call('plasticity_probe_surface',{'id':body,'rays':rays,'revision':rev()})
    P=[(r_['intersections'][0]['pointMm'],r_['intersections'][0]['faceId']) for r_ in pr['rays'] if r_['intersections']]
    out=[]
    for (a,fa),(b_,fb),(c_,fc) in zip(P,P[1:],P[2:]):
        ab=[b_[i]-a[i] for i in range(2)]; bc=[c_[i]-b_[i] for i in range(2)]
        cr=ab[0]*bc[1]-ab[1]*bc[0]; la=math.hypot(*ab); lb=math.hypot(*bc); lc=math.hypot(c_[0]-a[0],c_[1]-a[1])
        out.append((round(2*cr/max(la*lb*lc,1e-9),4),[round(v,1) for v in b_],fb))
    return out
# ---------------------------------------------------------------- v4 (option A, no band): designed section family
DESIGN=dict(on=False, gamma=1.0, amp=1.0)
def to_th(poly, T, B, o):
    c=[B[i]-T[i] for i in range(3)]; cl=math.sqrt(dot(c,c)); ch=[x/cl for x in c]
    o=unitv([o[i]-dot(o,ch)*ch[i] for i in range(3)])
    pts=sorted((dot([q[i]-T[i] for i in range(3)],ch)/cl, dot([q[i]-T[i] for i in range(3)],o)/cl) for q in poly)
    import numpy as np
    return list(np.interp(TGRID,[a for a,_ in pts],[b for _,b in pts]))
def design_sections(p,F,topw,botw,ct,cb,ht,hb,flR,cen):
    """Sections between the flank rear edge (s=0) and the centre profile (s=1): h(s,t) = (1-w) h_flank + w h_centre,
    w = s^gamma, scaled by amp around the chord. One smooth family: same knots, smooth in s, so the loft stays fair."""
    ZB,hw=p['zb'],p['baseHW']
    fw=extract(flR,edge_by_ends(flR,F['c2'],[hw,0,ZB],True,tol=0.05))
    pf=wire_poly(fw); pc=wire_poly(cen); delete([fw])
    _,_,_,_,o0,_=section_frame(ht,hb,0.0,INSIDE_SHELL); _,_,_,_,o1,_=section_frame(ht,hb,0.999,INSIDE_SHELL)
    hf=to_th(pf,F['c2'],[hw,0,ZB],o0); hc=to_th(pc,F['top'],[0,p['baseHD'],ZB],o1)
    out=[]
    import bspline
    mx=lambda q:[-q[0],q[1],q[2]]
    for s_ in SHELL_S:
        w=s_**DESIGN['gamma']
        T=exact_at(topw,ct,s_*0.5); Bq=exact_at(botw,cb,s_*0.5)
        _,_,_,_,o,_=section_frame(ht,hb,s_,INSIDE_SHELL)
        c=[Bq[i]-T[i] for i in range(3)]; cl=math.sqrt(dot(c,c)); ch=[x/cl for x in c]
        o=unitv([o[i]-dot(o,ch)*ch[i] for i in range(3)])
        h=[DESIGN['amp']*((1-w)*a+w*b) for a,b in zip(hf,hc)]; h[0]=0.0; h[-1]=0.0
        ctrl,err=bspline.fit_param(TGRID,[[t*cl,hh*cl] for t,hh in zip(TGRID,h)],NCTRL)
        FITLOG.append(dict(s=s_,w=round(w,3),fitErrMm=round(err,3)))
        out.append((plane_curve({'originMm':T,'uAxis':ch,'vAxis':o},ctrl,mode='control'),plane_curve({'originMm':mx(T),'uAxis':mx(ch),'vAxis':mx(o)},ctrl,mode='control')))
    return [a for a,_ in out],[b for _,b in out]
