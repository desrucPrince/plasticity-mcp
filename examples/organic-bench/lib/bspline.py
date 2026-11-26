import numpy as np
def knots(n,p=3):
    inner=n-p-1
    return [0]*(p+1)+[i/(inner+1) for i in range(1,inner+1)]+[1]*(p+1)
def basis(i,p,t,k):
    if p==0:
        return 1.0 if (k[i]<=t<k[i+1]) or (t==1 and k[i]<1<=k[i+1] and k[i+1]==1 and k[i]<k[i+1]) else 0.0
    a=0 if k[i+p]==k[i] else (t-k[i])/(k[i+p]-k[i])*basis(i,p-1,t,k)
    b=0 if k[i+p+1]==k[i+1] else (k[i+p+1]-t)/(k[i+p+1]-k[i+1])*basis(i+1,p-1,t,k)
    return a+b
def ev(P,t,p=3):
    P=np.array(P,float); k=knots(len(P),p)
    t=min(t,1-1e-12)
    return sum(basis(i,p,t,k)*P[i] for i in range(len(P)))
def sample(P,N=400): return np.array([ev(P,i/N) for i in range(N+1)])
def fit(points, nctrl=6, p=3, iters=4):
    """Least-squares cubic B-spline (clamped, uniform knots) through 2D points, ends fixed. Returns control points."""
    P=np.array(points,float); n=len(P)
    d=np.r_[0,np.cumsum(np.linalg.norm(np.diff(P,axis=0),axis=1))]; t=d/d[-1]
    k=knots(nctrl,p)
    for _ in range(iters):
        N=np.array([[basis(i,p,min(tt,1-1e-12),k) for i in range(nctrl)] for tt in t])
        A=N[:,1:-1]; rhs=P-np.outer(N[:,0],P[0])-np.outer(N[:,-1],P[-1])
        C=np.linalg.lstsq(A,rhs,rcond=None)[0]
        ctrl=np.vstack([P[0],C,P[-1]])
        # reparametrise by closest point (few Newton-free steps: dense sampling)
        S=sample(ctrl,600); ts=np.linspace(0,1,601)
        t=np.array([ts[np.argmin(np.linalg.norm(S-q,axis=1))] for q in P]); t[0]=0; t[-1]=1
    err=max(np.linalg.norm(ev(ctrl,tt)-q) for tt,q in zip(t,P))
    return ctrl.tolist(), float(err)
def fit_param(params, points, nctrl=9, p=3):
    """Least-squares clamped cubic B-spline with FIXED parameters (no re-parametrisation), ends fixed."""
    P=np.array(points,float); t=np.array(params,float); k=knots(nctrl,p)
    N=np.array([[basis(i,p,min(tt,1-1e-12),k) for i in range(nctrl)] for tt in t])
    A=N[:,1:-1]; rhs=P-np.outer(N[:,0],P[0])-np.outer(N[:,-1],P[-1])
    C=np.linalg.lstsq(A,rhs,rcond=None)[0]; ctrl=np.vstack([P[0],C,P[-1]])
    err=max(np.linalg.norm(ev(ctrl,tt)-q) for tt,q in zip(t,P))
    return ctrl.tolist(), float(err)
