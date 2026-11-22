// Builds solve.js from wasm/csv.ts: node wasm/build.mjs <dir holding node_modules/assemblyscript>
// The WebAssembly module is embedded in solve.js as base64, so the entry stays one dependency-free file.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const asDir = process.argv[2];
const wasmPath = join(here, 'csv.wasm');
execFileSync(join(asDir, 'node_modules/.bin/asc'), [join(here, 'csv.ts'), '-O3', '--runtime', 'stub', '--noAssert', '--enable', 'simd', '-o', wasmPath], { stdio: 'inherit' });
const b64 = readFileSync(wasmPath).toString('base64');
const template = readFileSync(join(here, 'solve.template.js'), 'utf8');
writeFileSync(join(here, '..', 'solve.js'), template.replace('__WASM_BASE64__', b64));
console.log(`solve.js written, wasm ${readFileSync(wasmPath).length} bytes`);
