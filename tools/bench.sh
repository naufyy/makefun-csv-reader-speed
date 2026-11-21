#!/bin/sh
# tools/bench.sh <kit dir> <rounds> <entry dir>...: CPU seconds of each entry's main.ts on the practice set, pinned to one CPU.
HOOK=$(cd "$(dirname "$0")" && pwd)/cpuhook.mjs
KIT=$1; R=$2; shift 2
OUT=$(mktemp -d)
for r in $(seq 1 $R); do
  for e in "$@"; do
    t=$(MAKEFUN_INPUT_DIR=$KIT/practice/input MAKEFUN_OUTPUT_DIR=$OUT taskset -c 0 node --import $HOOK $e/main.ts 2>&1 >/dev/null | grep '^CPU' | cut -d' ' -f2)
    echo "$e $t"
  done
done | awk '{s[$1]+=$2; n[$1]++; print} END {for (k in s) printf "MEAN %s %.3f\n", k, s[k]/n[k]}'
rm -rf $OUT
