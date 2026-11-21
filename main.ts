// The harness driver: `node /bot/main.ts` (Node 22). Reads every case from /input/cases.json (a JSON array of
// {id, input}), answers each one with run() from solve.js, and writes /output/answers.json: a JSON array of the
// answers, one per case and in the cases' order, byte for byte what JSON.stringify(answers) written as UTF-8 is.
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// It mirrors the house driver, with two changes that leave every output byte as it was:
//
// 1. Each answer is serialized and written as soon as it is read, and its case is let go, so the garbage collector
//    never has to copy or mark every answer at once.
//
// 2. Byte mode. When cases.json is valid UTF-8 and holds no \u escape of a non-ASCII character, it is decoded as
//    Latin-1: every UTF-8 byte becomes one character of a one-byte string. The reading only ever looks at ASCII
//    characters (comma, quote, CR, LF), and a UTF-8 multi-byte sequence holds no ASCII byte, so each field comes out as
//    exactly the bytes of the field csv-reader reads; the answers, serialized and written back as Latin-1, are then the
//    very bytes the UTF-8 path writes. The one character the reading treats specially that is not ASCII, a U+FEFF at
//    the very start of a text, is its three bytes EF BB BF here: they are cut off before run() sees the text, which
//    is what run() does with a leading U+FEFF. Anything else (invalid UTF-8, a \u escape that is not ASCII) takes the
//    plain UTF-8 path.

import { isUtf8 } from 'node:buffer';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8 flags set before solve.js is imported, as the house driver does. Turbofan off: on one CPU its compile time costs
// more than its faster code saves on inputs of this size (Maglev still optimizes).
setFlagsFromString('--no-incremental-marking');
setFlagsFromString('--no-turbofan');
setFlagsFromString('--no-lazy-feedback-allocation');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** True when every \u escape in the JSON bytes is of an ASCII character (\u0000 to \u007f), or there is none. */
function asciiEscapesOnly(raw: Buffer): boolean {
  for (let i = raw.indexOf('\\u'); i >= 0; i = raw.indexOf('\\u', i + 2)) {
    // A match may be an escaped backslash followed by a literal u: rejecting it too only costs the fast path.
    if (raw[i + 2] !== 0x30 || raw[i + 3] !== 0x30 || raw[i + 4] < 0x30 || raw[i + 4] > 0x37) return false;
  }
  return true;
}

const raw = readFileSync(join(INPUT_DIR, 'cases.json'));
const bytes = isUtf8(raw) && asciiEscapesOnly(raw);
const cases = JSON.parse(bytes ? raw.toString('latin1') : raw.toString('utf8')) as ({ id: string; input: any } | null)[];
const encoding = bytes ? 'latin1' : 'utf8';

const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
writeSync(fd, '[');
for (let i = 0; i < cases.length; i++) {
  let input = (cases[i] as { input: any }).input;
  cases[i] = null;
  if (bytes && input !== null && typeof input === 'object' && typeof input.text === 'string' && input.text.startsWith('\xEF\xBB\xBF')) {
    input = { text: input.text.slice(3), header: input.header };
  }
  writeSync(fd, (i === 0 ? '' : ',') + (JSON.stringify(run(input)) ?? 'null'), null, encoding);
}
writeSync(fd, ']');
closeSync(fd);
