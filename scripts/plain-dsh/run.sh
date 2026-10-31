#!/bin/bash
# run.sh <profile> <mode> <out> [port]  — boot a plain dsh web profile with the driver, wait for output, stop.
P=$1; M=$2; O=$3; PORT=${4:-3401}
B=${DSH_BIN:-dsh}
rm -f $O
mapfile -t E < <(grep -vE '^(__CURSOR)' ${ENV_FILE:?set ENV_FILE} | grep -vE '^(HOME|DSH_HOME)=')
env -i "${E[@]}" HOME=${PLAIN_HOME:?set PLAIN_HOME} STANDIN_API_KEY=standin JW_DEBUG_PERSONA=$JW_DEBUG_PERSONA DRIVER_OUT=$O DRIVER_MODE=$M DRIVER_CWD=${PLAIN_HOME:?set PLAIN_HOME}/sandbox setsid $B --profile $P --host 127.0.0.1 --port $PORT --no-open </dev/null > ${PLAIN_HOME:?set PLAIN_HOME}/$P.log 2>&1 &
PID=$!
for i in $(seq 1 180); do [ -f $O ] && break; kill -0 $PID 2>/dev/null || break; sleep 1; done
sleep 1; kill -INT -$PID 2>/dev/null; sleep 3; kill -9 -$PID 2>/dev/null
[ -f $O ] && echo "done $O" || { echo "no output"; tail -20 ${PLAIN_HOME:?set PLAIN_HOME}/$P.log; }
