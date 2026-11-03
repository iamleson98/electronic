// Behavioural-source expressions: the app's language ↔ ngspice B-source syntax.
//
// The app evaluates if(c, a, b), limit(x, lo, hi) and log() = natural log.
// ngspice has no if() or limit() ("no such function 'if'" aborted the whole
// netlist) and spells the conditional c ? a : b; its log() is not reliably
// natural across versions, ln() is. Everything else (arithmetic, comparisons,
// exp/ln/log10/sin/cos/tan/abs/sqrt/min/max, V(…), I(…), time, pi) is common.

/** Split on `sep` at parenthesis depth 0. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

/** Index of the ')' matching the '(' at `open`, or -1. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/** "(x)" → "x" when the outer parentheses wrap the whole string. */
function unwrap(s: string): string {
  const t = s.trim();
  return t.startsWith('(') && matchParen(t, 0) === t.length - 1 ? unwrap(t.slice(1, -1)) : t;
}

/**
 * Rewrite every `name(args)` call via `call` (arguments already converted by
 * `inner`) and every bare `( … )` group via `group`.
 */
function mapCalls(s: string, call: (name: string, args: string[]) => string, inner: (s: string) => string, group: (body: string) => string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '(') {
      const close = matchParen(s, i);
      if (close < 0) return out + s.slice(i);
      const m = /([A-Za-z_]\w*)\s*$/.exec(out);
      const body = s.slice(i + 1, close);
      if (m) {
        out = out.slice(0, out.length - m[0].length);
        out += call(m[1], splitTop(body, ',').map((a) => inner(a.trim())));
      } else {
        out += group(body);
      }
      i = close + 1;
    } else {
      out += s[i++];
    }
  }
  return out;
}

/** App expression → ngspice B-source expression. */
export function toSpiceExpr(expr: string): string {
  const conv = (s: string): string => mapCalls(s, (name, a) => {
    const fn = name.toLowerCase();
    if (fn === 'if' && a.length === 3) return `((${a[0]}) ? (${a[1]}) : (${a[2]}))`;
    if (fn === 'limit' && a.length === 3) return `max(${a[1]}, min(${a[0]}, ${a[2]}))`;
    if (fn === 'log') return `ln(${a.join(', ')})`;
    return `${name}(${a.join(', ')})`;
  }, conv, (body) => `(${conv(body)})`);
  return conv(expr);
}

/** ngspice B-source expression → app expression (c ? a : b → if(c, a, b)). */
export function fromSpiceExpr(expr: string): string {
  const conv = (s: string): string => {
    // top-level ternary (lowest precedence, right-associative)
    let depth = 0;
    let q = -1;
    for (let i = 0; i < s.length && q < 0; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      else if (s[i] === '?' && depth === 0) q = i;
    }
    if (q >= 0) {
      let nest = 0;
      depth = 0;
      for (let i = q + 1; i < s.length; i++) {
        const c = s[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (depth === 0 && c === '?') nest++;
        else if (depth === 0 && c === ':') {
          if (nest === 0) {
            return `if(${conv(unwrap(s.slice(0, q)))}, ${conv(unwrap(s.slice(q + 1, i)))}, ${conv(unwrap(s.slice(i + 1)))})`;
          }
          nest--;
        }
      }
    }
    return mapCalls(s, (name, a) => `${name}(${a.join(', ')})`, (arg) => conv(unwrap(arg)), (body) => {
      // a parenthesised ternary becomes a call — its parentheses are redundant
      const c = conv(body);
      return c.startsWith('if(') && matchParen(c, 2) === c.length - 1 ? c : `(${c})`;
    });
  };
  return conv(unwrap(expr));
}
