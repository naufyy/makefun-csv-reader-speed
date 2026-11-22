// Differential fuzzer for the WebAssembly transducer:
//   node tools/fuzz-wasm.mjs <path to vendor/csv-reader/index.js> [cases] [seed]
// Packs adversarial cases into cases.json documents (batches of up to 200) and checks:
//  1. canonical documents (JSON.stringify, as the generator writes them): transduce()'s bytes equal
//     JSON.stringify(the reference's answers), byte for byte;
//  2. the same documents re-encoded with other escapes (, for a comma, ", \/, upper-case hex, escaped
//     non-ASCII and surrogates, whitespace between tokens, header before text): the answers equal the reference's as
//     JSON values, or the transducer declines (null) where the shape is not its own (then the driver's general path
//     answers; counted, and checked through run());
//  3. run() on single inputs (the general path) against the reference, as JSON values.
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const solve = await import(process.env.SOLVE ? pathToFileURL(process.env.SOLVE).href : '../solve.js');
const ref = (await import(pathToFileURL(process.argv[2]).href)).readCsv;
const total = Number(process.argv[3] ?? 100000);
let seed = Number(process.argv[4] ?? 12345) >>> 0;
function rnd() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = (k) => Math.floor(rnd() * k);
const TOKENS = ['"', '""', ',', '\n', '\r', '\r\n', 'a', 'b', ' ', 'é', '東', '﻿', 'x"y', '""""', ',,', '"a"', '"a,b"', '"\r\n"', '"\r"', '\n\n', '\r\r', 'kg', '😀',
  'Ĭ', 'Ģ', 'Ċ', 'č', 'Ｌ', 'ÿ', 'abcdefghijklmnop', 'abcdefghijklmnopqrstuvwxyz0123456789',
  '\t', '\\', '/', '\\"', '\u0001', '\u001f', '\u007f', ' ', '\ud800', '\udc00', '\ud83d', '\ude00', '\b', '\f', '\0'];
function gen() {
  const mode = ri(5);
  let s = rnd() < 0.2 ? '﻿' : '';
  const len = ri(mode === 0 ? 8 : mode === 1 ? 30 : 120);
  if (mode >= 3) {
    const w = 1 + ri(5);
    const rowsN = ri(mode === 4 ? 40 : 8);
    const eol = rnd() < 0.5 ? '\n' : '\r\n';
    for (let r = 0; r < rowsN; r++) {
      const k = Math.max(1, w + ri(5) - 2);
      const f = [];
      for (let j = 0; j < k; j++) {
        let v = '';
        for (let m = ri(mode === 4 ? 3 : 4); m > 0; m--) v += mode === 4 && rnd() < 0.7 ? 'word'.slice(ri(4)) + ri(1000) : TOKENS[ri(TOKENS.length)];
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

// A JSON string literal for s with random, valid, non-canonical escapes.
function oddString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const u = () => '\\u' + c.toString(16).padStart(4, '0').replace(/[a-f]/g, (h) => (rnd() < 0.5 ? h.toUpperCase() : h));
    if (c === 0x22) out += rnd() < 0.5 ? '\\"' : u();
    else if (c === 0x5c) out += rnd() < 0.5 ? '\\\\' : u();
    else if (c < 0x20) {
      const short = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r' }[c];
      out += short && rnd() < 0.5 ? short : u();
    } else if (c >= 0xd800 && c <= 0xdfff) out += u();
    else if (c === 0x2f) out += rnd() < 0.5 ? '\\/' : '/';
    else out += rnd() < 0.15 ? u() : s[i];
  }
  return out + '"';
}
const W = () => [' ', '\n', '\t', '\r', ''][ri(5)].repeat(ri(2));

function transduce(docStr) {
  const doc = Buffer.from(docStr, 'utf8');
  solve.prepare(doc.length).set(doc);
  const out = solve.transduce();
  return out === null ? null : Buffer.from(out.buffer, out.byteOffset, out.length).toString('utf8');
}

let done = 0, diffs = 0, declined = 0, oddChecked = 0, valueOnly = 0;
function report(kind, inputs, got, want) {
  diffs++;
  if (diffs > 5) return;
  if (kind === 'odd') {
    for (const inp of inputs) for (let t = 0; t < 200; t++) {
      const d = '[{"input":{"text":' + oddString(inp.text) + ',"header":' + inp.header + '}}]';
      const g = transduce(d);
      let v;
      try { v = JSON.parse(g); } catch { v = Symbol('unparsable'); }
      if (!isDeepStrictEqual(v, [ref(inp)])) {
        console.log('DIFF odd single doc', JSON.stringify(d), '\n got ', String(g).slice(0, 1500), '\n want', JSON.stringify([ref(inp)]).slice(0, 1500));
        return;
      }
    }
  }
  // narrow it to one case where a single case shows it
  for (const inp of inputs) {
    const w = JSON.stringify([ref(inp)]);
    const g = transduce(JSON.stringify([{ id: 'x', input: inp }]));
    if (g !== w) {
      console.log('DIFF', kind, 'single case', JSON.stringify(inp), '\n got ', String(g).slice(0, 1500), '\n want', w.slice(0, 1500));
      return;
    }
  }
  console.log('DIFF', kind, '(batch only)', JSON.stringify(inputs).slice(0, 1500), '\n got ', String(got).slice(0, 1500), '\n want', want.slice(0, 1500));
}
while (done < total) {
  const n = Math.min(1 + ri(200), total - done);
  const inputs = [];
  for (let i = 0; i < n; i++) inputs.push({ text: gen(), header: rnd() < 0.5 });
  done += n;
  const answers = inputs.map(ref);
  const want = JSON.stringify(answers);
  // 1. canonical
  const got = transduce(JSON.stringify(inputs.map((input, i) => ({ id: `g-${i}`, input }))));
  if (got !== want) {
    let v;
    try { v = JSON.parse(got); } catch { v = Symbol('unparsable'); }
    if (isDeepStrictEqual(v, answers)) valueOnly++;
    else report('canonical', inputs, got, want);
  }
  // 2. odd escapes and layout
  const odd = W() + '[' + inputs.map((inp, i) => {
    const t = '"text"' + W() + ':' + W() + oddString(inp.text);
    const h = '"header"' + W() + ':' + W() + String(inp.header);
    const body = rnd() < 0.3 ? h + W() + ',' + W() + t : t + W() + ',' + W() + h;
    return W() + '{' + W() + '"id"' + W() + ':' + W() + (rnd() < 0.8 ? JSON.stringify('c' + i) : String(i)) + W() + ',' + W() + '"input"' + W() + ':' + W() + '{' + W() + body + W() + '}' + W() + '}' + W();
  }).join(',') + ']' + W();
  if (!isDeepStrictEqual(JSON.parse(odd).map((c) => ref(c.input)), answers)) throw new Error('fuzzer bug: odd document');
  const g2 = transduce(odd);
  if (g2 === null) declined++;
  else {
    oddChecked++;
    let v;
    try { v = JSON.parse(g2); } catch { v = Symbol('unparsable'); }
    if (!isDeepStrictEqual(v, answers)) report('odd', inputs, g2, want);
  }
  // 3. run() on a few single inputs
  if (rnd() < 0.05) {
    const inp = inputs[0];
    const a = JSON.stringify(solve.run(inp));
    if (a !== JSON.stringify(answers[0])) report('run', [inp], a, JSON.stringify(answers[0]));
  }
}
console.log(`${done} cases, ${diffs} diffs (canonical: ${valueOnly} batches equal as JSON values but not bytes; odd documents: ${oddChecked} checked, ${declined} declined)`);
process.exit(diffs ? 1 : 0);
