// Differential fuzzer: node tools/fuzz.mjs <path to vendor/csv-reader/index.js> [iterations] [seed]
import { pathToFileURL } from 'node:url';
// Compares solve.js's run with csv-reader 1.0.0's readCsv on adversarial CSV texts, as JSON values.
import { isDeepStrictEqual } from 'node:util';

const { run } = await import(process.env.SOLVE ? pathToFileURL(process.env.SOLVE).href : '../solve.js');

const ref = (await import(pathToFileURL(process.argv[2]).href)).readCsv;
const iters = Number(process.argv[3] ?? 200000);
let seed = Number(process.argv[4] ?? 12345) >>> 0;
function rnd() { // mulberry32
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = (k) => Math.floor(rnd() * k);
const TOKENS = ['"', '""', ',', '\n', '\r', '\r\n', 'a', 'b', ' ', 'é', '東', '﻿', 'x"y', '""""', ',,', '"a"', '"a,b"', '"\r\n"', '"\r"', '\n\n', '\r\r', 'kg', '😀',
  // wide characters whose low byte is a comma, quote, LF or CR (the one-byte copy must never be sliced across them)
  'Ĭ', 'Ģ', 'Ċ', 'č', 'Ｌ', 'ÿ', 'abcdefghijklmnop'];
function gen() {
  const mode = ri(4);
  let s = rnd() < 0.2 ? '﻿' : '';
  const len = ri(mode === 0 ? 8 : mode === 1 ? 30 : 120);
  if (mode === 3) {
    // structured: rows of fields, some quoted, some broken
    const w = 1 + ri(5);
    const rowsN = ri(8);
    const eol = rnd() < 0.5 ? '\n' : '\r\n';
    for (let r = 0; r < rowsN; r++) {
      const k = Math.max(1, w + ri(5) - 2);
      const f = [];
      for (let j = 0; j < k; j++) {
        let v = '';
        for (let m = ri(4); m > 0; m--) v += TOKENS[ri(TOKENS.length)];
        if (rnd() < 0.4) v = '"' + v.replaceAll('"', '""') + '"' + (rnd() < 0.2 ? TOKENS[ri(TOKENS.length)] : '');
        f.push(v);
      }
      s += f.join(',') + (rnd() < 0.1 ? '\r' : '') + eol;
      if (rnd() < 0.1) s += eol;
    }
    if (rnd() < 0.3) s = s.slice(0, s.length - eol.length);
    return s;
  }
  for (let i = 0; i < len; i++) s += TOKENS[ri(TOKENS.length)];
  return s;
}
let diffs = 0;
for (let it = 0; it < iters; it++) {
  const input = { text: gen(), header: rnd() < 0.5 };
  const a = run(input);
  const b = ref(input);
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))) {
    diffs++;
    if (diffs <= 5) console.log('DIFF', JSON.stringify(input), '\n mine', JSON.stringify(a), '\n ref ', JSON.stringify(b));
  }
}
console.log(`${iters} cases, ${diffs} diffs`);
process.exit(diffs ? 1 : 0);
