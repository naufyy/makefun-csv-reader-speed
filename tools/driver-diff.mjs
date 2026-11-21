// Driver-level differential test: node tools/driver-diff.mjs <kit dir> [files] [seed]
// Writes cases.json files (generator draws on fresh seeds, adversarial fuzz texts with BOMs, wide characters, emoji,
// lone surrogates and \u escapes, some forcing the plain UTF-8 path), runs the house baseline's main.ts and this
// entry's main.ts on each, and compares the two answers.json files byte for byte.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const kit = process.argv[2];
const files = Number(process.argv[3] ?? 20);
let seed = Number(process.argv[4] ?? 99) >>> 0;
const g = join(kit, 'program/generator');
const { streamFor } = await import(pathToFileURL(join(g, 'rng.ts')).href);
const { generate } = await import(pathToFileURL(join(g, 'subject/csv-cases.mjs')).href);
function rnd() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = (k) => Math.floor(rnd() * k);
const T = ['"', '""', ',', '\n', '\r', '\r\n', 'a', 'bc', ' ', 'é', 'ÿ', '東京', '﻿', '﻿﻿', 'x"y', ',,', '"a,b"', '"\r"', '\n\n', 'Ĭ', 'Ģ', 'Ċ', 'č', '😀', '\u0000', '\u001f', '\t', '\\', '\\u00e9', 'Москва'];
const TB = T.filter((t) => t !== '\\u00e9'); // without a literal backslash-u, so the file can take byte mode
const fuzzText = (toks) => { let s = rnd() < 0.3 ? '﻿' : ''; for (let i = ri(200); i > 0; i--) s += toks[ri(toks.length)]; return s; };
let byteFiles = 0;
const base = join(kit, 'baselines/csv-reader/main.ts');
const mine = new URL('../main.ts', import.meta.url).pathname;
let bad = 0;
for (let f = 0; f < files; f++) {
  const cases = [];
  const kind = f % 4; // 0: generator draws, 1: fuzz texts, 2: fuzz + a lone surrogate (plain path), 3: mixed
  const count = kind === 0 ? 3 : 40;
  for (let i = 0; i < count; i++) {
    let text = kind === 0 || (kind === 3 && i % 10 === 0) ? generate(streamFor(`drv-${seed}-${f}-${i}`, 'case', i), i).text : fuzzText(kind === 2 ? T : TB);
    if (kind === 2 && i === count - 1) text += '\uD800,\uDFFF\n';
    cases.push({ id: `c-${i}`, input: { text, header: rnd() < 0.6 } });
  }
  const dir = mkdtempSync(join(tmpdir(), 'drv-'));
  mkdirSync(join(dir, 'in')); mkdirSync(join(dir, 'a')); mkdirSync(join(dir, 'b'));
  const json = JSON.stringify(cases);
  if (!/\\u(?!00[0-7])/.test(json) && !/[\uD800-\uDFFF]/.test(json.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) byteFiles++;
  writeFileSync(join(dir, 'in', 'cases.json'), json);
  for (const [main, out] of [[base, 'a'], [mine, 'b']]) {
    const r = spawnSync(process.execPath, [main], { env: { ...process.env, MAKEFUN_INPUT_DIR: join(dir, 'in'), MAKEFUN_OUTPUT_DIR: join(dir, out) }, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`${main} failed`);
  }
  const a = readFileSync(join(dir, 'a', 'answers.json'));
  const b = readFileSync(join(dir, 'b', 'answers.json'));
  if (!a.equals(b)) { bad++; console.log('DIFF in', dir, 'kind', kind); } else rmSync(dir, { recursive: true });
}
console.log(`${files} cases.json files (${byteFiles} in byte mode), ${bad} byte diffs`);
