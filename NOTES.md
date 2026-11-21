# csv-reader-speed-01 entry: notes

## What is here

- `solve.js`: my own implementation of csv-reader 1.0.0's `readCsv` semantics, exporting `run(input)`. It is a single
  left-to-right pass. Unquoted fields are found with native `indexOf` on cached next-comma, next-LF and next-CR
  positions, and quoted fields close at the first undoubled quote, found with `indexOf('"')`. Fields are text slices,
  and string building happens only for `""`, CR inside quotes, lone CRs and quote junk. The code is split into small
  functions (record, quoted field, rare lone-CR path) so V8 compiles each one cheaply and once. A warmup at import
  runs every branch on tiny texts, so the optimizer has full type feedback and doesn't deoptimize midway.
- `main.ts`: the driver. It has the baseline's structure (read `/input/cases.json`, `run` each case, write
  `/output/answers.json`), with these changes, none of which alters an output byte:
  1. Streaming output: each answer is serialized and written right after it is computed, and the case is released.
     The file is byte-identical to `JSON.stringify(answers)`, but the GC never copies or marks all answers at once.
  2. Byte mode: if `cases.json` is valid UTF-8 (`buffer.isUtf8`) and has no `\u` escape of a non-ASCII character,
     it is decoded as Latin-1, one char per byte. The reader only reacts to ASCII (`,` `"` CR LF), and UTF-8
     multibyte sequences contain no ASCII bytes, so every field is exactly the UTF-8 bytes of csv-reader's field.
     Output is written back as Latin-1, which reproduces the UTF-8 bytes. The only non-ASCII character with
     special meaning, a leading U+FEFF, appears as the bytes EF BB BF; the driver strips them before calling `run`,
     which matches what `run` does with a leading U+FEFF. Any other file takes the ordinary UTF-8 path. Everything
     stays one-byte, so JSON parse, the scan and stringify are all faster.
  3. V8 flags: `--no-incremental-marking` (as the baseline), `--no-turbofan` and `--no-lazy-feedback-allocation`.
     On one CPU, TurboFan's compile time cost more than its faster code saved at this input size; Maglev still
     optimizes.
- `tools/`: test and benchmark scripts. They take the kit path as an argument.
  - `fuzz.mjs`: adversarial differential fuzzer against the vendored csv-reader.
  - `gen-diff.ts`: draws full-size cases from the kit's generator on fresh seeds and diffs against csv-reader.
  - `driver-diff.mjs`: runs the baseline's `main.ts` and this `main.ts` on synthetic `cases.json` files and compares
    the `answers.json` bytes. It covers both byte mode and the UTF-8 fallback.
  - `bench.sh` with `cpuhook.mjs`: process CPU time (user+sys, all threads) pinned to one CPU.

## Differential testing (final code)

- Practice set: 6/6 identical to `practice/reference/expected.json`, and `answers.json` is byte-identical to the
  baseline driver's file. `grade-local --driver process --worktree`: passed 1, cases 6/6, both executions
  reproduced byte for byte.
- Fuzzer: 2,000,000 adversarial cases (8 seeds × 250k), **0 diffs**. Inputs mix embedded and doubled quotes, CRLF and
  lone CR inside and outside quotes, unterminated quotes, BOMs, blank lines, short and long rows, trailing commas,
  non-ASCII, emoji, and wide characters whose low byte is `,` `"` LF or CR. In total, well over 4M fuzz cases ran
  during development across versions. A mutation check (three deliberately broken copies of solve.js) was caught
  by the fuzzer every time (1,451 to 7,049 diffs per 20k cases).
- Generator draws: 150 full-size cases (1.4–2.0M characters each) on fresh seeds, **0 diffs**, plus about 200 more
  during development.
- Driver level: 40 `cases.json` files (30 in byte mode, 10 forced onto the UTF-8 path by lone surrogates or
  non-ASCII `\u` escapes), **0 byte diffs** against the baseline driver's output. About 120 more files during
  development.
- The fuzzer found one real bug during optimization: a lone CR as the last character of the text was taken for a
  CRLF. It was fixed before adoption.

## Benchmark (practice set, about 10.6 MB of CSV, Node 24.22 locally, `taskset -c 0`, 15 rounds, mean CPU)

| entry | CPU (s) | net of node startup (do-nothing main.ts = 0.150 s) |
|---|---|---|
| baseline (csv-reader 1.0.0) | 1.660 | 1.510 |
| this entry | 0.427 | 0.277 |

That is 3.9x faster on total process CPU and about 5.4x on net CPU. Rough per-phase split for this entry:
read 20 ms, JSON parse 38 ms, run 120 ms, stringify 65 ms, write 8 ms.

Dead ends, measured and dropped:
- Slicing from a one-byte copy of a two-byte text: V8's JSON serializer switches the whole output to two-byte at
  the first wide string, so nothing was gained.
- Re-exec'ing node with heap-size flags (startup cost more than it saved).
- TurboFan for only the hot functions (`--turbo-filter`).
- Preallocating row arrays.
- A `split(',')` fast path for quote-free lines (only 14–36% of lines qualify).

## Remaining risks

- Node version: RULES.txt says the grader runs Node 22.23.4, while grade-local reported the server harness on
  v26.13.1. I could only test on Node 24.22 (no docker, no Node 22 here). The APIs used (`buffer.isUtf8`,
  `Buffer#toString('latin1')`, `fs.writeSync` with an encoding) exist on all of these versions. The V8 flags only
  affect speed, and an unknown flag cannot change output. The flag tuning was measured on V8 for Node 24, so the
  speedup could differ on another V8, but correctness does not depend on it.
- Byte mode depends on the input being the generator's `JSON.stringify` output, which writes non-ASCII raw. It
  checks its own preconditions (valid UTF-8, only ASCII `\u` escapes) and otherwise falls back to the plain path.
  The output is written as Latin-1, which is lossless only because in byte mode every output character is ≤ U+00FF:
  fields are byte-chars, and everything else is ASCII.
- Timing noise on this machine was about ±5%. The margin over the baseline is far larger than that.
- Performance on pathological inputs: a quote that never closes scans to the end of the text, as csv-reader does.
  After the first one, any later quoted field closes within its own run of quotes, so there is no quadratic blow-up.
