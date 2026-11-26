"""Negative control: a 0.3 degree crease between two R20/R20 arcs. Must FAIL G1 at 0.1 degrees."""
from s0_controls import build, dims
NAME='s0b_crease'; EXPECT_FAIL=True; EXPECT_SOLID=False
DEFAULT=dict(r1=20.0, r2=20.0, crease=0.3)
def plan(p): return [dict(name='0.3 deg crease must not pass G1',select=dict(vertical=True),target='G1',expectCount=1),dict(name='rest',select=dict(rest=True),target='any')]
