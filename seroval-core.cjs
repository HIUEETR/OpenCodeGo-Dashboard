// seroval-core.js — SolidStart server-function wire codec (JS port of py-opencode-go/seroval.py)
// Works in Node (module.exports) and in userscript page context (window.SerovalCore).
// No eval: response expressions are parsed with a small tokenizer/parser.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SerovalCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ------------------------------------------------------------- encode args
  function encodeArgs(args) {
    const refs = new Map();
    let counter = 0;
    let usedRefs = false;

    function enc(v) {
      if (v === null || v === undefined) return { t: 2, s: 0 };
      if (v === true) return { t: 2, s: 2 };
      if (v === false) return { t: 2, s: 3 };
      if (typeof v === "string") return { t: 1, s: v };
      if (typeof v === "number") return { t: 0, s: v };
      if (Array.isArray(v)) {
        if (refs.has(v)) { usedRefs = true; return { t: 4, i: refs.get(v) }; }
        const idx = counter++;
        refs.set(v, idx);
        return { t: 9, i: idx, l: v.length, a: v.map(enc), o: 0 };
      }
      if (typeof v === "object") {
        if (refs.has(v)) { usedRefs = true; return { t: 4, i: refs.get(v) }; }
        const idx = counter++;
        refs.set(v, idx);
        const keys = Object.keys(v);
        return { t: 10, i: idx, p: { k: keys, v: keys.map((k) => enc(v[k])), s: keys.length }, o: 0 };
      }
      throw new Error("unsupported arg type: " + typeof v);
    }

    const tree = enc(Array.from(args));
    return JSON.stringify({ t: tree, f: 31, m: usedRefs ? [1] : [] });
  }

  // ------------------------------------------------------------- decode stream
  const NUM_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y;

  function tokenize(text) {
    const tokens = [];
    let pos = 0;
    while (pos < text.length) {
      const ch = text[pos];
      if (/\s/.test(ch)) { pos++; continue; }
      if (text.startsWith("$R", pos)) { tokens.push(["ref"]); pos += 2; continue; }
      if ("[]{}:(),=!".includes(ch)) { tokens.push([ch]); pos++; continue; }
      if (ch === '"') {
        const m = /"(?:\\.|[^"\\])*"/y;
        m.lastIndex = pos;
        const mm = m.exec(text);
        if (!mm) throw new Error("bad string at " + pos);
        tokens.push(["str", JSON.parse(mm[0])]);
        pos = mm[0].length + pos;
        continue;
      }
      NUM_RE.lastIndex = pos;
      const nm = NUM_RE.exec(text);
      if (nm && /[0-9]/.test(ch)) {
        const raw = nm[0];
        tokens.push(["num", raw.includes(".") || /[eE]/.test(raw) ? parseFloat(raw) : parseInt(raw, 10)]);
        pos = nm.index + raw.length;
        continue;
      }
      IDENT_RE.lastIndex = pos;
      const im = IDENT_RE.exec(text);
      if (im) {
        tokens.push(["ident", im[0]]);
        pos = im.index + im[0].length;
        continue;
      }
      throw new Error("unexpected char " + JSON.stringify(ch) + " at " + pos);
    }
    return tokens;
  }

  class Parser {
    constructor(tokens) {
      this.toks = tokens;
      this.i = 0;
      this.store = new Map();
    }
    peek() { return this.toks[this.i]; }
    next() { return this.toks[this.i++]; }
    expect(kind) {
      const t = this.next();
      if (t[0] !== kind) throw new Error("expected " + kind + ", got " + JSON.stringify(t));
      return t;
    }
    parseValue() {
      const t = this.peek();
      if (!t) throw new Error("unexpected end");
      const kind = t[0];
      if (kind === "ref") {
        this.next();
        this.expect("[");
        const idx = this.expect("num")[1];
        this.expect("]");
        const nxt = this.peek();
        if (nxt && nxt[0] === "=") {
          this.next();
          const value = this.parseValue();
          this.store.set(idx, value);
          return value;
        }
        if (this.store.has(idx)) return this.store.get(idx);
        throw new Error("unresolved ref $R[" + idx + "]");
      }
      if (kind === "{") return this.parseObject();
      if (kind === "[") return this.parseArray();
      if (kind === "(") { this.next(); const v = this.parseValue(); this.expect(")"); return v; }
      if (kind === "!") {
        this.next();
        const nxt = this.next();
        if (nxt[1] === 0) return true;
        if (nxt[1] === 1) return false;
        throw new Error("bad ! literal " + JSON.stringify(nxt));
      }
      if (kind === "ident") {
        this.next();
        const v = t[1];
        if (v === "null" || v === "undefined") return null;
        if (v === "true") return true;
        if (v === "false") return false;
        if (v === "void") { this.expect("num"); return null; }
        if (v === "new") {
          const name = this.expect("ident")[1];
          if (name !== "Date") throw new Error("unsupported constructor " + name);
          this.expect("(");
          const s = this.expect("str")[1];
          this.expect(")");
          return s;
        }
        throw new Error("unsupported identifier " + v);
      }
      if (kind === "str" || kind === "num") { this.next(); return t[1]; }
      throw new Error("unexpected token " + JSON.stringify(t));
    }
    parseObject() {
      this.expect("{");
      const obj = {};
      if (this.peek() && this.peek()[0] === "}") { this.next(); return obj; }
      for (;;) {
        const k = this.next();
        if (k[0] !== "str" && k[0] !== "ident") throw new Error("bad object key " + JSON.stringify(k));
        this.expect(":");
        obj[k[1]] = this.parseValue();
        const sep = this.peek();
        if (sep && sep[0] === ",") { this.next(); continue; }
        if (sep && sep[0] === "}") { this.next(); return obj; }
        throw new Error("bad object separator " + JSON.stringify(sep));
      }
    }
    parseArray() {
      this.expect("[");
      const arr = [];
      if (this.peek() && this.peek()[0] === "]") { this.next(); return arr; }
      for (;;) {
        arr.push(this.parseValue());
        const sep = this.peek();
        if (sep && sep[0] === ",") { this.next(); continue; }
        if (sep && sep[0] === "]") { this.next(); return arr; }
        throw new Error("bad array separator " + JSON.stringify(sep));
      }
    }
  }

  function stripWrapper(expr) {
    if (expr.startsWith("(($R=>")) return expr.slice("(($R=>".length);
    let m = /^\(\(self\.\$R=self\.\$R\|\|\{\}\)\[[^\]]*\]=\[\],/.exec(expr);
    if (!m) m = /^\(\(self\.\$R=.*?\]=\[\],/.exec(expr);
    if (m) {
      expr = expr.slice(m[0].length);
      if (expr.startsWith("($R=>")) expr = expr.slice("($R=>".length);
    }
    return expr;
  }

  function decodeStream(body) {
    let text = typeof body === "string" ? body : new TextDecoder().decode(body);
    let chunks;
    if (!text.startsWith(";0x")) {
      chunks = [text];
    } else {
      chunks = [];
      let pos = 0;
      for (;;) {
        const m = /;0x([0-9a-fA-F]{8});/.exec(text.slice(pos));
        if (!m) {
          if (text.slice(pos).trim()) throw new Error("bad chunk framing at " + pos);
          break;
        }
        const size = parseInt(m[1], 16);
        const start = pos + m.index + m[0].length;
        chunks.push(text.slice(start, start + size));
        pos = start + size;
      }
    }
    if (!chunks.length) throw new Error("empty server-function response");
    const parser = new Parser(tokenize(stripWrapper(chunks[0])));
    return parser.parseValue();
  }

  function decodeJsonOrStream(body) {
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    const s = text.trimStart();
    if (s.startsWith("{") || s.startsWith("[")) {
      try { return JSON.parse(text); } catch (e) { /* fallthrough */ }
    }
    return decodeStream(text);
  }

  return { encodeArgs, decodeStream, decodeJsonOrStream };
});
