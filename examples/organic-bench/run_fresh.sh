#!/bin/zsh
# usage: run_fresh.sh LABEL PORT [MCP_ROOT] [extra run_bench args]
# Fresh isolated Plasticity 26.1.3 (private profile + TMPDIR), stdio MCP daemon, full benchmark, then cleanup.
LABEL=$1; PORT=$2; ROOT=${3:-$HOME/Projects/plasticity-mcp}; shift 3 2>/dev/null
HERE=$(cd $(dirname $0) && pwd); W=$HERE/runs/_w-$LABEL; mkdir -p $W/scratch
NODE=$HOME/.nvm/versions/node/v24.21.0/bin/node
(cd $ROOT && $NODE scripts/start-plasticity-isolated.ts > $W/isolated.json 2> $W/isolated.err)
CDP=$(python3.11 -c "import json;print(json.load(open('$W/isolated.json'))['rendererEndpoint'])")
PROF=$(python3.11 -c "import json,os;print(os.path.basename(json.load(open('$W/isolated.json'))['userDataDirectory']))")
echo "window $CDP $PROF"
PLASTICITY_MCP_ROOT=$ROOT PLASTICITY_CDP_URL=$CDP PLD_SCRATCH=$W/scratch PLD_PORT=$PORT nohup $NODE $HERE/tools/daemon2.mjs > $W/daemon.log 2> $W/daemon.err &
DPID=$!
for i in $(seq 1 60); do sleep 1; grep -q port $W/daemon.log && break; done
PLD_PORT=$PORT python3.11 $HERE/run_bench.py $LABEL --sweep "$@" > $W/bench.log 2>&1
CHILD=$(pgrep -P $DPID); kill $DPID $CHILD 2>/dev/null; sleep 2
pgrep -f "$PROF" | xargs kill 2>/dev/null; sleep 3; pgrep -f "$PROF" | xargs kill -9 2>/dev/null
grep -E '"passed"|"total"' $W/bench.log; grep -c FAIL $W/bench.log; true
