// A fast reader with csv-reader 1.0.0's exact semantics: run({text, header}) -> {columns, rows, errors}.
//
// One left-to-right pass over the text by char codes; fields are slices of the text (no per-character string
// building), a quoted field's closing quote is found with indexOf. The work is split into small functions (a record,
// a quoted field, the rare lone-CR path) so V8 compiles each one cheaply and once; CPU time spent compiling counts.
// Dependency-free and pure: the module state below is scratch, reset by every call.

// Scratch state shared by the readers within one run() call.
let pos = 0; // the next character to read
let line = 1; // the line that character is on
let term = 0; // how the last field ended: 0 at a comma, 1 at a line break or the end of the text
let added = 0; // characters readBare kept (dropped lone CRs not counted)
let nLF = -1; // the first LF at or after some earlier point (n when none), refreshed lazily
let nCR = -1; // likewise for CR

function err(code, l, row) {
  return { code, line: l, row };
}

// The unquoted reader for a field holding a lone CR (or junk after a closing quote): reads from i onto `prefix` up to
// a comma, LF, CRLF or the end, dropping each CR not followed by LF with a stray_cr error. Sets pos, term, added; a
// line break ending the field is counted.
function readBare(text, i, n, prefix, errors, recLine, recRow) {
  let v = prefix;
  let from = i;
  let kept = 0;
  for (;;) {
    if (i >= n) {
      v += text.slice(from, n);
      kept += n - from;
      pos = n;
      term = 1;
      break;
    }
    const c = text.charCodeAt(i);
    if (c === 44) {
      v += text.slice(from, i);
      kept += i - from;
      pos = i + 1;
      term = 0;
      break;
    }
    if (c === 10) {
      v += text.slice(from, i);
      kept += i - from;
      pos = i + 1;
      line += 1;
      term = 1;
      break;
    }
    if (c === 13) {
      v += text.slice(from, i);
      kept += i - from;
      if (i + 1 < n && text.charCodeAt(i + 1) === 10) {
        pos = i + 2;
        line += 1;
        term = 1;
        break;
      }
      errors.push(err('stray_cr', recLine, recRow));
      i += 1;
      from = i;
      continue;
    }
    i += 1;
  }
  added = kept;
  return v;
}

// A quoted field's value with "" read as one quote and CRLF or a lone CR as LF, counting its line breaks.
function unescape(text, s, q) {
  let v = '';
  let from = s;
  for (let k = s; k < q; k++) {
    const c = text.charCodeAt(k);
    if (c === 34) {
      v += text.slice(from, k + 1);
      k += 1;
      from = k + 1;
    } else if (c === 13) {
      v += text.slice(from, k) + '\n';
      line += 1;
      if (text.charCodeAt(k + 1) === 10) k += 1;
      from = k + 1;
    } else if (c === 10) {
      line += 1;
    }
  }
  return v + text.slice(from, q);
}

// The field whose opening quote is at p. Sets pos and term.
function readQuoted(text, p, n, errors, recLine, recRow) {
  const s = p + 1;
  let i = s;
  let dbl = false;
  let q;
  for (;;) {
    q = text.indexOf('"', i);
    if (q < 0 || text.charCodeAt(q + 1) !== 34) break;
    dbl = true;
    i = q + 2;
  }
  if (q < 0) {
    // It never closes: the quote is a literal character and the text after it is read again as unquoted.
    errors.push(err('unterminated_quote', recLine, recRow));
    return readBare(text, s, n, '"', errors, recLine, recRow);
  }
  if (nLF < s) {
    nLF = text.indexOf('\n', s);
    if (nLF < 0) nLF = n;
  }
  if (nCR < s) {
    nCR = text.indexOf('\r', s);
    if (nCR < 0) nCR = n;
  }
  let v = !dbl && nLF > q && nCR > q ? text.slice(s, q) : unescape(text, s, q);
  i = q + 1;
  if (i >= n) {
    pos = n;
    term = 1;
    return v;
  }
  const c = text.charCodeAt(i);
  if (c === 44) {
    pos = i + 1;
    term = 0;
    return v;
  }
  if (c === 10) {
    pos = i + 1;
    line += 1;
    term = 1;
    return v;
  }
  if (c === 13 && text.charCodeAt(i + 1) === 10) {
    pos = i + 2;
    line += 1;
    term = 1;
    return v;
  }
  // What follows the closing quote, up to the next comma or line break, is appended as it stands.
  v = readBare(text, i, n, v, errors, recLine, recRow);
  if (added > 0) errors.push(err('quote_junk', recLine, recRow));
  return v;
}

// One record starting at pos (not at an empty line). Returns its fields; `quotedLast` tells whether its last field
// opened with a quote.
let quotedLast = false;
let nC = -1; // the first comma at or after some earlier point (n when none)
function readRecord(text, n, errors, recLine, recRow) {
  const fields = [];
  let p = pos;
  for (;;) {
    if (text.charCodeAt(p) === 34) {
      fields.push(readQuoted(text, p, n, errors, recLine, recRow));
      p = pos;
      if (term === 0) continue;
      quotedLast = true;
      return fields;
    }
    if (nC < p) {
      nC = text.indexOf(',', p);
      if (nC < 0) nC = n;
    }
    if (nLF < p) {
      nLF = text.indexOf('\n', p);
      if (nLF < 0) nLF = n;
    }
    if (nCR < p) {
      nCR = text.indexOf('\r', p);
      if (nCR < 0) nCR = n;
    }
    if (nC < nLF && nC < nCR) {
      fields.push(text.slice(p, nC));
      p = nC + 1;
      continue;
    }
    if (nCR < nLF) {
      // A CR before the field ends at a comma or LF.
      if (nCR + 1 === nLF && nLF < n) {
        fields.push(text.slice(p, nCR));
        pos = nLF + 1;
        line += 1;
        break;
      }
      fields.push(readBare(text, nCR, n, text.slice(p, nCR), errors, recLine, recRow));
      p = pos;
      if (term === 0) continue;
      break;
    }
    if (nLF < n) {
      fields.push(text.slice(p, nLF));
      pos = nLF + 1;
      line += 1;
      break;
    }
    fields.push(text.slice(p, n));
    pos = n;
    break;
  }
  quotedLast = false;
  return fields;
}

function shortRow(l, row, count) {
  return { code: 'short_row', line: l, row, fields: count };
}

function longRow(l, row, extra) {
  return { code: 'long_row', line: l, row, extra };
}

/** csv-reader 1.0.0's reading of {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const rows = [];
  const errors = [];
  let columns = null;
  let width = -1;
  let wantHeader = header;
  pos = n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  line = 1;
  nLF = -1;
  nCR = -1;
  nC = -1;

  for (;;) {
    // Lines with no characters (LF or CRLF) are no records.
    let p = pos;
    while (p < n) {
      const c = text.charCodeAt(p);
      if (c === 10) {
        p += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(p + 1) === 10) {
        p += 2;
        line += 1;
      } else break;
    }
    if (p >= n) break;
    pos = p;

    const recLine = line;
    const recRow = wantHeader ? null : rows.length;
    const fields = readRecord(text, n, errors, recLine, recRow);
    const len = fields.length;
    // A line left with no characters (it held only lone CRs) is no record; its stray_cr errors stay.
    if (len === 1 && !quotedLast && fields[0] === '') continue;

    if (width < 0) width = len;
    if (wantHeader) {
      columns = fields;
      wantHeader = false;
      continue;
    }
    if (len < width) {
      errors.push(shortRow(recLine, recRow, len));
      for (let k = len; k < width; k++) fields.push('');
    } else if (len > width) {
      errors.push(longRow(recLine, recRow, fields.splice(width)));
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

// Warm-up: readings of small texts that take every branch, so the optimizing compiler sees complete type feedback and
// does not deoptimize and recompile midway through a large input. Their results are dropped.
const WARM = [
  '﻿a,b,c\n1,2,3\r\n\n\r\n"q""x","y\r\nz\rw\nv",p\n"j"kg,"k"\r\n',
  'x,y\n1,2\r3\n\r\r\n"a"\rb,"c"\r,d\n1\n1,2,3,4\n"open,1\n2,"x"',
  'hé,東\n"",\n"a"\n"z",q',
  '',
];
for (let r = 0; r < 12; r++) for (let i = 0; i < WARM.length; i++) run({ text: WARM[i], header: (r + i) % 2 === 0 });
