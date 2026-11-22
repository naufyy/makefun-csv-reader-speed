// csv-reader 1.0.0's reading, run({text, header}) -> {columns, rows, errors}, done by a WebAssembly transducer.
//
// The module (built from wasm/csv.ts by wasm/build.mjs, embedded below as base64) reads a cases.json document, the
// JSON array [{"id", "input": {"text", "header"}}, ...], and writes the JSON array of the answers in one pass, straight
// from the JSON-escaped texts: each escape is taken for the character it stands for, and every character that is not a
// comma, quote, CR or LF is copied to the answer exactly as it is written. run() wraps one input as such a document.
// The driver (main.ts) hands it the whole file. Dependency-free and pure: the module's memory is scratch.

const WASM = '__WASM_BASE64__';

const instance = new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(WASM, 'base64')), {});
const wasm = instance.exports;

/** Room for a document of `length` bytes in the module's memory: write it into the returned bytes. */
export function prepare(length) {
  const at = wasm.prepare(length);
  return new Uint8Array(wasm.memory.buffer, at, length);
}

/** The answers to the prepared document as UTF-8 JSON bytes (a view of the module's memory), or null when the
 * document is outside the shape the transducer reads (the caller then answers it the general way). */
export function transduce() {
  let n;
  try {
    n = wasm.transduce();
  } catch {
    return null;
  }
  if (n < 0) return null;
  return new Uint8Array(wasm.memory.buffer, wasm.outStart(), n);
}

/** csv-reader 1.0.0's reading of {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  // JSON.stringify escapes lone surrogates, so the UTF-8 bytes carry every code unit of the text.
  const doc = Buffer.from('[{"input":{"text":' + JSON.stringify(text) + ',"header":' + header + '}}]', 'utf8');
  prepare(doc.length).set(doc);
  const out = transduce();
  if (out === null) throw new Error('transducer refused its own document');
  return JSON.parse(Buffer.from(out.buffer, out.byteOffset, out.length).toString('utf8'))[0];
}
