// Draws full-size cases with the kit's generator on fresh seeds and diffs solve.js against csv-reader 1.0.0.
// node tools/gen-diff.ts <kit dir> [count] [seed prefix]
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { run } from '../solve.js';

const kit = process.argv[2];
const count = Number(process.argv[3] ?? 60);
const prefix = process.argv[4] ?? 'fuzz';
const g = join(kit, 'program/generator');
const { streamFor } = await import(pathToFileURL(join(g, 'rng.ts')).href);
const { generate } = await import(pathToFileURL(join(g, 'subject/csv-cases.mjs')).href);
const { readCsv } = await import(pathToFileURL(join(g, 'vendor/csv-reader/index.js')).href);
let diffs = 0;
for (let i = 0; i < count; i++) {
  const input = generate(streamFor(`${prefix}-${i}`, 'case', i), i);
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(run(input))), JSON.parse(JSON.stringify(readCsv(input))))) {
    diffs++;
    console.log('DIFF case', i);
  }
}
console.log(`${count} generated cases, ${diffs} diffs`);
