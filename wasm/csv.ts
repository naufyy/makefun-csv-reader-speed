// csv-reader 1.0.0 as a byte transducer: cases.json bytes in, answers.json bytes out.
//
// The input is the JSON array [{"id": ..., "input": {"text": "...", "header": true|false}}, ...]. Each text is read
// straight from its JSON string form: an escape is taken for the character it stands for (so , is a comma), and
// every character that is not a comma, quote, CR or LF is copied to the output exactly as it is written, escape and
// all. Output strings use the same JSON escaping as the input, so the answers decode to csv-reader's strings code unit
// for code unit (and, for JSON.stringify's own escaping, byte for byte as JSON.stringify writes them).
//
// Anything outside the shape above (another key, a duplicate key, a text that is not a string, a header that is not
// true or false, malformed JSON) makes transduce() return -1, and the JS side answers the file the slow, general way.

let bad: bool = false;

// Regions: input at IN (followed by a sentinel), output from OUT growing up, the current case's errors from errBase
// growing up to memEnd. When the output runs into errBase, the error region is moved up.
let IN: usize = 0;
let INLEN: usize = 0;
let OUT: usize = 0;
let o: usize = 0; // output write position
let errBase: usize = 0;
let e: usize = 0; // error write position
let memEnd: usize = 0;
let nErr: i32 = 0;

let p: usize = 0; // input read position
let line: i32 = 1;
let recLine: i32 = 1;
let recRow: i32 = -1; // -1: null (the header)

const PAGE: usize = 65536;
const SLACK: usize = 256;

function growTo(end: usize): void {
  const have = (<usize>memory.size()) * PAGE;
  if (end > have) {
    const pages = <i32>((end - have + PAGE - 1) / PAGE);
    if (memory.grow(pages) < 0) unreachable();
  }
  memEnd = (<usize>memory.size()) * PAGE - SLACK;
}

/** Makes room for the input; returns where JS writes it. */
export function prepare(inLen: usize): usize {
  IN = (__heap_base + 15) & ~(<usize>15);
  INLEN = inLen;
  OUT = (IN + inLen + SLACK + 15) & ~(<usize>15);
  errBase = OUT + inLen * 2 + (1 << 20);
  growTo(errBase + (1 << 20) + SLACK);
  // Sentinel: a run of quotes ends any string scan; the JSON parse then fails on it.
  memory.fill(IN + inLen, 0x22, SLACK);
  return IN;
}

export function outStart(): usize {
  return OUT;
}

@inline function ensureOut(n: usize): void {
  if (o + n + SLACK > errBase) moveErr(o + n + SLACK);
}

function moveErr(need: usize): void {
  let shift = need - errBase;
  if (shift < (16 << 20)) shift = 16 << 20;
  const len = e - errBase;
  growTo(e + shift + SLACK * 2);
  memory.copy(errBase + shift, errBase, len);
  errBase += shift;
  e += shift;
}

@inline function ensureErr(n: usize): void {
  if (e + n > memEnd) growTo(e + n + (16 << 20) + SLACK * 2);
}

// ---- output helpers ----

@inline function put(c: u8): void {
  store<u8>(o, c);
  o += 1;
}

function putStr(at: usize, s: string): usize {
  const n = s.length;
  const src = changetype<usize>(s);
  for (let i = 0; i < n; i++) store<u8>(at + i, <u8>load<u16>(src + (i << 1)));
  return at + n;
}

function putInt(at: usize, v: i32): usize {
  if (v < 0) return putStr(at, 'null');
  let tmp: u32 = <u32>v;
  let digits = 1;
  for (let t = tmp; t >= 10; t /= 10) digits++;
  let q = at + digits;
  do {
    q -= 1;
    store<u8>(q, <u8>(48 + (tmp % 10)));
    tmp /= 10;
  } while (tmp != 0);
  return at + digits;
}

// error record start: {"code":"<code>","line":L,"row":R   (the caller closes it)
function errOpen(code: string): void {
  ensureErr(160);
  if (nErr > 0) {
    store<u8>(e, 0x2c);
    e += 1;
  }
  nErr++;
  e = putStr(e, '{"code":"');
  e = putStr(e, code);
  e = putStr(e, '","line":');
  e = putInt(e, recLine);
  e = putStr(e, ',"row":');
  e = putInt(e, recRow);
}

function errSimple(code: string): void {
  errOpen(code);
  store<u8>(e, 0x7d);
  e += 1;
}

// ---- reading characters of a JSON string ----

let cLen: usize = 0; // byte length of the character peek() read

function hex4(q: usize): i32 {
  let v: i32 = 0;
  for (let i: usize = 0; i < 4; i++) {
    const h = <i32>load<u8>(q + i);
    let d: i32;
    if (h >= 48 && h <= 57) d = h - 48;
    else if (h >= 97 && h <= 102) d = h - 87;
    else if (h >= 65 && h <= 70) d = h - 55;
    else {
      bad = true;
      return -1;
    }
    v = (v << 4) | d;
  }
  return v;
}

/** The character at q: -1 at the string's closing quote (the end of the text); its byte length in cLen. */
function peek(q: usize): i32 {
  const b = <i32>load<u8>(q);
  if (b == 0x22) {
    cLen = 0;
    return -1;
  }
  if (b != 0x5c) {
    cLen = 1;
    return b;
  }
  const x = <i32>load<u8>(q + 1);
  cLen = 2;
  switch (x) {
    case 0x6e: return 10; // n
    case 0x72: return 13; // r
    case 0x22: return 34;
    case 0x5c: return 92;
    case 0x2f: return 47;
    case 0x62: return 8;
    case 0x66: return 12;
    case 0x74: return 9;
    case 0x75: {
      cLen = 6;
      const v = hex4(q + 2);
      if (v < 0) {
        cLen = 0;
        return -1;
      }
      return v;
    }
  }
  bad = true;
  cLen = 0;
  return -1;
}

// ---- the CSV reading ----

const COMMA: i32 = 0;
const BREAK: i32 = 1;
const END: i32 = 2;

let lastQuoted: bool = false;

/** Unquoted characters from p onto the output, up to a comma, a line break or the end. */
function readUnq(): i32 {
  const sComma = i8x16.splat(0x2c);
  const sBack = i8x16.splat(0x5c);
  const sQuote = i8x16.splat(0x22);
  while (true) {
    const v = v128.load(p);
    v128.store(o, v);
    const m = i8x16.bitmask(v128.or(v128.or(i8x16.eq(v, sComma), i8x16.eq(v, sBack)), i8x16.eq(v, sQuote)));
    if (m == 0) {
      p += 16;
      o += 16;
      continue;
    }
    const k = <usize>ctz<u32>(m);
    p += k;
    o += k;
    const b = load<u8>(p);
    if (b == 0x2c) {
      p += 1;
      return COMMA;
    }
    if (b == 0x22) return END;
    // an escape
    const x = load<u8>(p + 1);
    let c: i32;
    if (x == 0x6e) {
      p += 2;
      line++;
      return BREAK;
    }
    if (x == 0x72) {
      c = 13;
      cLen = 2;
    } else if (x == 0x75) {
      c = peek(p);
      if (c < 0) return END; // bad
      if (c == 0x2c) {
        p += 6;
        return COMMA;
      }
      if (c == 10) {
        p += 6;
        line++;
        return BREAK;
      }
      if (c != 13) {
        // copied as written (a quote included: inside an unquoted field it is a literal character)
        memory.copy(o, p, 6);
        p += 6;
        o += 6;
        continue;
      }
    } else {
      store<u16>(o, load<u16>(p));
      p += 2;
      o += 2;
      continue;
    }
    // a CR: a line break when LF follows, else dropped
    const l = cLen;
    if (peek(p + l) == 10) {
      p += l + cLen;
      line++;
      return BREAK;
    }
    errSimple('stray_cr');
    p += l;
  }
}

/** The quoted field whose opening quote (of byte length ql) is at p. */
function readQuoted(ql: usize): i32 {
  const open = p;
  const openLine = line;
  const o0 = o; // just after the field's opening framing quote
  p += ql;
  return quotedRest(open, ql, openLine, o0);
}

/** The rest of a quoted field from p (opened at `open` on line openLine, its value written from o0 on). */
function quotedRest(open: usize, ql: usize, openLine: i32, o0: usize): i32 {
  const sBack = i8x16.splat(0x5c);
  const sQuote = i8x16.splat(0x22);
  while (true) {
    const v = v128.load(p);
    v128.store(o, v);
    const m = i8x16.bitmask(v128.or(i8x16.eq(v, sBack), i8x16.eq(v, sQuote)));
    if (m == 0) {
      p += 16;
      o += 16;
      continue;
    }
    const k = <usize>ctz<u32>(m);
    p += k;
    o += k;
    if (load<u8>(p) == 0x22) {
      // The end of the text: the quote never closes. It is a literal character; the rest is read again unquoted.
      if (bad) return END;
      p = open + ql;
      o = o0;
      line = openLine;
      errSimple('unterminated_quote');
      store<u16>(o, 0x225c); // \"
      o += 2;
      return readUnq();
    }
    const x = load<u8>(p + 1);
    let c: i32;
    if (x == 0x22) {
      c = 34;
      cLen = 2;
    } else if (x == 0x6e) {
      store<u16>(o, 0x6e5c);
      o += 2;
      p += 2;
      line++;
      continue;
    } else if (x == 0x72) {
      c = 13;
      cLen = 2;
    } else if (x == 0x75) {
      c = peek(p);
      if (c < 0) return END; // bad
      if (c == 10) {
        store<u16>(o, 0x6e5c);
        o += 2;
        p += 6;
        line++;
        continue;
      }
      if (c != 13 && c != 34) {
        memory.copy(o, p, 6);
        p += 6;
        o += 6;
        continue;
      }
    } else {
      store<u16>(o, load<u16>(p));
      p += 2;
      o += 2;
      continue;
    }
    if (c == 13) {
      store<u16>(o, 0x6e5c);
      o += 2;
      p += cLen;
      line++;
      if (peek(p) == 10) p += cLen;
      continue;
    }
    // a quote: doubled, it is one quote; else it closes the field
    p += cLen;
    const n = peek(p);
    if (n == 34) {
      store<u16>(o, 0x225c);
      o += 2;
      p += cLen;
      continue;
    }
    return afterClose();
  }
}

/** What follows a closing quote at p: the field's end, or junk appended as it stands. */
function afterClose(): i32 {
  {
    const n = peek(p);
    if (n < 0) return END;
    if (n == 0x2c) {
      p += cLen;
      return COMMA;
    }
    if (n == 10) {
      p += cLen;
      line++;
      return BREAK;
    }
    if (n == 13) {
      const l = cLen;
      if (peek(p + l) == 10) {
        p += l + cLen;
        line++;
        return BREAK;
      }
    }
    // junk after the closing quote, appended as it stands
    const oj = o;
    const r = readUnq();
    if (o > oj) errSimple('quote_junk');
    return r;
  }
}

let gExtra: usize = 0; // where a record's cut fields start in the output
let gFieldStart: usize = 0; // where its last field starts

/** One record's fields from p onto the output (comma-separated JSON strings; from field `width` on, when `cut`,
 * without the comma before the first cut one, which starts at gExtra). Returns the field count.
 *
 * The common cases (plain characters, the escapes \" \n \r \r\n and the other two-byte ones) are read here with
 * the state in locals; anything else (a \u escape, a lone CR, junk after a closing quote, a quote that never
 * closes) hands the rest of the field to the general readers above. */
function readFields(width: i32, cut: bool): i32 {
  let lp = p;
  let lo = o;
  let ln = line;
  let nf: i32 = 0;
  let quoted = false;
  let r: i32 = 0;
  const sC = i8x16.splat(0x2c);
  const sB = i8x16.splat(0x5c);
  const sQ = i8x16.splat(0x22);
  while (true) {
    if (nf > 0) {
      if (nf == width && cut) gExtra = lo;
      else {
        store<u8>(lo, 0x2c);
        lo++;
      }
    }
    gFieldStart = lo;
    store<u8>(lo, 0x22);
    lo++;
    nf++;
    const h = load<u16>(lp);
    if (h == 0x225c) {
      // a quoted field
      quoted = true;
      const open = lp;
      const openLine = ln;
      const o0 = lo;
      lp += 2;
      while (true) {
        const v = v128.load(lp);
        v128.store(lo, v);
        const m = i8x16.bitmask(v128.or(i8x16.eq(v, sB), i8x16.eq(v, sQ)));
        if (m == 0) {
          lp += 16;
          lo += 16;
          continue;
        }
        const k = <usize>ctz<u32>(m);
        lp += k;
        lo += k;
        const x = load<u16>(lp);
        const x2 = load<u16>(lp + 2);
        if (x == 0x225c && x2 != 0x755c) {
          if (x2 == 0x225c) {
            // doubled: one quote
            store<u16>(lo, 0x225c);
            lp += 4;
            lo += 2;
            continue;
          }
          lp += 2;
          const n = load<u8>(lp);
          if (n == 0x2c) {
            lp++;
            r = COMMA;
            break;
          }
          if (n == 0x22) {
            r = END;
            break;
          }
          const y = load<u32>(lp);
          if ((y & 0xffff) == 0x6e5c) {
            lp += 2;
            ln++;
            r = BREAK;
            break;
          }
          if (y == 0x6e5c725c) {
            lp += 4;
            ln++;
            r = BREAK;
            break;
          }
          p = lp;
          o = lo;
          line = ln;
          r = afterClose();
          lp = p;
          lo = o;
          ln = line;
          break;
        }
        if (x == 0x6e5c) {
          store<u16>(lo, 0x6e5c);
          lp += 2;
          lo += 2;
          ln++;
          continue;
        }
        if (x == 0x725c) {
          if (x2 != 0x755c) {
            store<u16>(lo, 0x6e5c);
            lo += 2;
            ln++;
            lp += x2 == 0x6e5c ? 4 : 2;
            continue;
          }
        } else if ((x & 0xff) == 0x5c && x != 0x755c && x != 0x225c) {
          store<u16>(lo, x);
          lp += 2;
          lo += 2;
          continue;
        }
        // a \u escape, a quote or CR before one, or the end of the text: the general reader
        p = lp;
        o = lo;
        line = ln;
        r = quotedRest(open, 2, openLine, o0);
        lp = p;
        lo = o;
        ln = line;
        break;
      }
    } else if (h == 0x755c) {
      // a field opening with a \u escape (it may be a quote): the general readers
      p = lp;
      o = lo;
      line = ln;
      const c = peek(p);
      if (c == 34) {
        quoted = true;
        r = readQuoted(cLen);
      } else {
        quoted = false;
        r = readUnq();
      }
      lp = p;
      lo = o;
      ln = line;
    } else {
      quoted = false;
      while (true) {
        const v = v128.load(lp);
        v128.store(lo, v);
        const m = i8x16.bitmask(v128.or(v128.or(i8x16.eq(v, sC), i8x16.eq(v, sB)), i8x16.eq(v, sQ)));
        if (m == 0) {
          lp += 16;
          lo += 16;
          continue;
        }
        const k = <usize>ctz<u32>(m);
        lp += k;
        lo += k;
        const b = load<u8>(lp);
        if (b == 0x2c) {
          lp++;
          r = COMMA;
          break;
        }
        if (b == 0x22) {
          r = END;
          break;
        }
        const x = load<u8>(lp + 1);
        if (x == 0x6e) {
          lp += 2;
          ln++;
          r = BREAK;
          break;
        }
        if (x == 0x72) {
          if (load<u16>(lp + 2) == 0x6e5c) {
            lp += 4;
            ln++;
            r = BREAK;
            break;
          }
        } else if (x != 0x75) {
          store<u16>(lo, load<u16>(lp));
          lp += 2;
          lo += 2;
          continue;
        }
        // a \u escape or a CR not followed by \n: the general reader
        p = lp;
        o = lo;
        line = ln;
        r = readUnq();
        lp = p;
        lo = o;
        ln = line;
        break;
      }
    }
    store<u8>(lo, 0x22);
    lo++;
    if (r != COMMA || bad) break;
  }
  p = lp;
  o = lo;
  line = ln;
  lastQuoted = quoted;
  return nf;
}

/** The text string whose opening quote is at p (header known); writes the answer. */
function readText(header: bool, textLen: usize): void {
  p += 1;
  line = 1;
  nErr = 0;
  e = errBase;
  // a U+FEFF at the very start is dropped
  if (load<u8>(p) == 0xef && load<u8>(p + 1) == 0xbb && load<u8>(p + 2) == 0xbf) p += 3;
  else if (load<u8>(p) == 0x5c && load<u8>(p + 1) == 0x75 && hex4(p + 2) == 0xfeff) p += 6;
  // a record's output is at most 3 bytes per byte it reads, padding aside (ensured where it is written)
  ensureOut(textLen * 3 + 1024);
  o = putStr(o, '{"columns":');
  let wantHeader = header;
  if (!header) o = putStr(o, 'null,"rows":[');
  let width: i32 = -1;
  let nRows: i32 = 0;
  while (!bad) {
    // lines with no characters are no records
    let b = load<u8>(p);
    if (b == 0x5c) {
      let c = peek(p);
      while (true) {
        if (c == 10) {
          p += cLen;
          line++;
        } else if (c == 13) {
          const l = cLen;
          if (peek(p + l) != 10) break;
          p += l + cLen;
          line++;
        } else break;
        c = peek(p);
      }
      if (c < 0) break;
    } else if (b == 0x22) break;
    recLine = line;
    recRow = wantHeader ? -1 : nRows;
    const recStart = o;
    if (!wantHeader && nRows > 0) put(0x2c);
    put(0x5b);
    const nf = readFields(width, !wantHeader);
    const extra = gExtra;
    const fieldStart = gFieldStart;
    if (bad) break;
    if (nf == 1 && !lastQuoted && o == fieldStart + 2) {
      // a line that held only stray CRs: no record (its errors stay)
      o = recStart;
      continue;
    }
    if (width < 0) width = nf;
    if (wantHeader) {
      ensureOut(64);
      put(0x5d);
      o = putStr(o, ',"rows":[');
      wantHeader = false;
      continue;
    }
    if (nf < width) {
      errOpen('short_row');
      e = putStr(e, ',"fields":');
      e = putInt(e, nf);
      store<u8>(e, 0x7d);
      e += 1;
      const pads = <usize>(width - nf);
      ensureOut(pads * 3 + 64);
      for (let i: usize = 0; i < pads; i++) {
        store<u8>(o, 0x2c);
        store<u16>(o + 1, 0x2222);
        o += 3;
      }
    } else if (nf > width) {
      const len = o - extra;
      errOpen('long_row');
      ensureErr(len + 64);
      e = putStr(e, ',"extra":[');
      memory.copy(e, extra, len);
      e += len;
      store<u16>(e, 0x7d5d);
      e += 2;
      o = extra;
    }
    put(0x5d);
    nRows++;
  }
  if (bad) return;
  // p is at the text's closing quote
  p += 1;
  ensureOut(e - errBase + 64);
  if (wantHeader) o = putStr(o, '[],"rows":[');
  o = putStr(o, '],"errors":[');
  memory.copy(o, errBase, e - errBase);
  o += e - errBase;
  o = putStr(o, ']}');
}

// ---- the JSON around the texts ----

@inline function ws(): void {
  while (true) {
    const b = load<u8>(p);
    if (b == 0x20 || b == 0x0a || b == 0x0d || b == 0x09) p++;
    else break;
  }
}

function skipString(): void {
  // p at the opening quote
  p += 1;
  const sBack = i8x16.splat(0x5c);
  const sQuote = i8x16.splat(0x22);
  while (true) {
    if (p >= IN + INLEN) {
      bad = true;
      return;
    }
    const v = v128.load(p);
    const m = i8x16.bitmask(v128.or(i8x16.eq(v, sBack), i8x16.eq(v, sQuote)));
    if (m == 0) {
      p += 16;
      continue;
    }
    p += <usize>ctz<u32>(m);
    if (load<u8>(p) == 0x22) {
      p += 1;
      return;
    }
    p += 2;
  }
}

// key codes
const K_OTHER = 0;
const K_ID = 1;
const K_INPUT = 2;
const K_TEXT = 3;
const K_HEADER = 4;

function keyIs(start: usize, len: usize, s: string): bool {
  if (len != <usize>s.length) return false;
  const src = changetype<usize>(s);
  for (let i: usize = 0; i < len; i++) if (<u16>load<u8>(start + i) != load<u16>(src + (i << 1))) return false;
  return true;
}

/** A key at p (an opening quote), then the colon; returns its code. */
function readKey(): i32 {
  if (load<u8>(p) != 0x22) {
    bad = true;
    return K_OTHER;
  }
  const s = p + 1;
  let q = s;
  while (true) {
    const b = load<u8>(q);
    if (b == 0x22) break;
    if (b == 0x5c || b < 0x20) {
      bad = true; // an escaped key: leave it to the general path
      return K_OTHER;
    }
    q++;
  }
  const len = q - s;
  p = q + 1;
  ws();
  if (load<u8>(p) != 0x3a) {
    bad = true;
    return K_OTHER;
  }
  p++;
  ws();
  if (keyIs(s, len, 'id')) return K_ID;
  if (keyIs(s, len, 'input')) return K_INPUT;
  if (keyIs(s, len, 'text')) return K_TEXT;
  if (keyIs(s, len, 'header')) return K_HEADER;
  return K_OTHER;
}

function lit(s: string): bool {
  const n = <usize>s.length;
  const src = changetype<usize>(s);
  for (let i: usize = 0; i < n; i++) if (<u16>load<u8>(p + i) != load<u16>(src + (i << 1))) return false;
  p += n;
  return true;
}

/** Skips any JSON value at p (strings, numbers, literals, arrays, objects). */
function skipValue(depth: i32): void {
  if (depth > 64) {
    bad = true;
    return;
  }
  const b = load<u8>(p);
  if (b == 0x22) {
    skipString();
    return;
  }
  if (b == 0x7b || b == 0x5b) {
    const close: u8 = b == 0x7b ? 0x7d : 0x5d;
    p++;
    ws();
    if (load<u8>(p) == close) {
      p++;
      return;
    }
    while (!bad) {
      if (b == 0x7b) {
        if (load<u8>(p) != 0x22) {
          bad = true;
          return;
        }
        skipString();
        ws();
        if (load<u8>(p) != 0x3a) {
          bad = true;
          return;
        }
        p++;
        ws();
      }
      skipValue(depth + 1);
      ws();
      const c = load<u8>(p);
      p++;
      if (c == close) return;
      if (c != 0x2c) {
        bad = true;
        return;
      }
      ws();
    }
    return;
  }
  if (lit('true') || lit('false') || lit('null')) return;
  // a number
  const s = p;
  while (true) {
    const c = load<u8>(p);
    if ((c >= 0x30 && c <= 0x39) || c == 0x2d || c == 0x2b || c == 0x2e || c == 0x65 || c == 0x45) p++;
    else break;
  }
  if (p == s) bad = true;
}

/** The input object at p: finds header first, then reads the text. */
function readInput(): void {
  if (load<u8>(p) != 0x7b) {
    bad = true;
    return;
  }
  const start = p;
  // pass 1: header and the text's position
  let header = false;
  let textAt: usize = 0;
  let textEnd: usize = 0;
  let seenHeader = false;
  p++;
  ws();
  if (load<u8>(p) == 0x7d) {
    bad = true; // no text
    return;
  }
  while (!bad) {
    const k = readKey();
    if (bad) return;
    if (k == K_TEXT) {
      if (textAt != 0 || load<u8>(p) != 0x22) {
        bad = true;
        return;
      }
      textAt = p;
      skipString();
      textEnd = p;
    } else if (k == K_HEADER) {
      if (seenHeader) {
        bad = true;
        return;
      }
      seenHeader = true;
      if (lit('true')) header = true;
      else if (lit('false')) header = false;
      else {
        bad = true;
        return;
      }
    } else {
      bad = true; // another key: the general path
      return;
    }
    ws();
    const c = load<u8>(p);
    p++;
    if (c == 0x7d) break;
    if (c != 0x2c) {
      bad = true;
      return;
    }
    ws();
  }
  if (bad || textAt == 0) {
    bad = true;
    return;
  }
  const end = p;
  p = textAt;
  readText(header, textEnd - textAt);
  p = end;
}

/** The whole cases.json (prepared at IN): the answers' length at OUT, or -1 for the general path. */
export function transduce(): i32 {
  bad = false;
  p = IN;
  o = OUT;
  ws();
  if (load<u8>(p) != 0x5b) return -1;
  p++;
  ws();
  put(0x5b);
  let n: i32 = 0;
  if (load<u8>(p) == 0x5d) {
    p++;
  } else {
    while (!bad) {
      if (load<u8>(p) != 0x7b) return -1;
      p++;
      ws();
      if (n > 0) put(0x2c);
      let seenId = false;
      let seenInput = false;
      if (load<u8>(p) == 0x7d) return -1; // no input
      while (!bad) {
        const k = readKey();
        if (bad) return -1;
        if (k == K_ID) {
          if (seenId) return -1;
          seenId = true;
          skipValue(0);
        } else if (k == K_INPUT) {
          if (seenInput) return -1;
          seenInput = true;
          readInput();
        } else return -1;
        ws();
        const c = load<u8>(p);
        p++;
        if (c == 0x7d) break;
        if (c != 0x2c) return -1;
        ws();
      }
      if (bad || !seenInput) return -1;
      n++;
      ws();
      const c = load<u8>(p);
      p++;
      if (c == 0x5d) break;
      if (c != 0x2c) return -1;
      ws();
    }
  }
  if (bad) return -1;
  ws();
  if (p != IN + INLEN) return -1;
  ensureOut(8);
  put(0x5d);
  return <i32>(o - OUT);
}
