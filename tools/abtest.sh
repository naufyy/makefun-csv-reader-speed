#!/bin/sh
# tools/abtest.sh <kit dir> <rounds> <A entry> <B entry>...: paired CPU comparison on the practice set, one CPU.
# Each round runs every entry once (interleaved); prints per entry the trimmed mean (2 fastest and 2 slowest dropped,
# as the heat does) and the median of its per-round ratio to A.
HOOK=$(cd "$(dirname "$0")" && pwd)/cpuhook.mjs
KIT=$1; R=$2; shift 2
OUT=$(mktemp -d)
for r in $(seq 1 $R); do
  for e in "$@"; do
    t=$(MAKEFUN_INPUT_DIR=$KIT/practice/input MAKEFUN_OUTPUT_DIR=$OUT taskset -c 0 node --import $HOOK $e/main.ts 2>&1 >/dev/null | grep '^CPU' | cut -d' ' -f2)
    echo "$r $e $t"
  done
done | node -e '
const rows=require("fs").readFileSync(0,"utf8").trim().split("\n").map(l=>l.split(" "));
const ents=[...new Set(rows.map(r=>r[1]))];const by=new Map(ents.map(e=>[e,new Map()]));
for(const [r,e,t] of rows) by.get(e).set(r,+t);
const A=by.get(ents[0]);const med=a=>{a=[...a].sort((x,y)=>x-y);return a[a.length>>1]};
for(const e of ents){const v=[...by.get(e).values()].sort((x,y)=>x-y);const tr=v.slice(2,v.length-2);
const ratios=[...by.get(e)].map(([r,t])=>t/A.get(r));
console.log(e,"trimmed",(tr.reduce((a,b)=>a+b,0)/tr.length).toFixed(3),"median-ratio-to-A",med(ratios).toFixed(3))}'
rm -rf $OUT
