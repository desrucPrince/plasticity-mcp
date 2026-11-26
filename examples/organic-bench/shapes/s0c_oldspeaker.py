"""Negative control: the attempt-3 speaker (out3). Its flank/side join has a real curvature mismatch (0.077 vs
0.0019 /mm in a 0.2 mm strip), so a G2 target there must FAIL."""
from blocks import *
NAME='s0c_oldspeaker'; EXPECT_FAIL=True
DEFAULT=dict(src=0.0)
NO_SWEEP=('src',)
def build(p):
    open_doc(ROOT+'/out4/baseline.plasticity',ROOT+'/bench/runs/_backups')
    return solids()[0]
def plan(p):
    return [dict(name='flank/side R must not pass G2',select=dict(nearPointMm=[42.8,-8.0,51.2],tol=1.5),target='G2',expectCount=1),
            dict(name='rest',select=dict(rest=True),target='any')]
def dims(p, body): return {}
