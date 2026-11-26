#!/bin/zsh
# usage: start-daemon.sh CDP_URL PORT ROOT DIR
CDP=$1; PORT=$2; ROOT=$3; DIR=$4
cd $DIR
PLASTICITY_EXPERIMENTAL_TOOLS=surface_align PLASTICITY_MCP_ROOT=$ROOT PLASTICITY_CDP_URL=$CDP PLD_SCRATCH=$DIR/scratch PLD_PORT=$PORT nohup ~/.nvm/versions/node/v24.21.0/bin/node $(dirname $0)/daemon2.mjs > $DIR/daemon.log 2> $DIR/daemon.err &
echo $! > $DIR/daemon.pid
for i in $(seq 1 60); do sleep 1; grep -q port $DIR/daemon.log && break; done; cat $DIR/daemon.log
