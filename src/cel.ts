/**
 * autocheck — CEL with gap.
 *
 * A check is a CEL predicate string. We parse it and evaluate it directly,
 * returning `{ pass, gap, why }` — the gap is the distance from satisfaction
 * (the gradient), the thing CEL itself doesn't give you. Agents are fluent in
 * CEL; there is no bespoke op-tree to learn or serialize. The syntax is CEL,
 * the gap is ours.
 *
 * Supported predicate subset (everything with a computable gap):
 *
 *   spend_usd <= 2.0                                  numeric distance
 *   sheet.days_since_modified >= 1
 *   asset.status == "active"   /   != "x"             equality (gap 1/0)
 *   note.content.contains("Total")                    substring
 *   has(account.token)         /   !has(account.token)existence
 *   jobs.filter(j, j.status == "failed").size() == 0  count(predicate)
 *   assets.size() >= 3                                count
 *   notes.exists(n, n.len >= 40)                      any-match (min sub-gap)
 *   notes.all(n, n.has_content)                       all-match (gap = #violations)
 *   a && b   /   a || b   /   !a                      compose
 *
 * Anything outside this (arithmetic, string building, joins) has no defined gap
 * — it throws CelError, and the caller routes that criterion to the LLM judge.
 */

import type { CheckResult } from "./check.js";
import { resolve } from "./path.js";

export class CelError extends Error {
  constructor(message: string) { super(`CEL: ${message}`); this.name = "CelError"; }
}

// ── Tokenizer ──────────────────────────────────────────────────────────────
type Tok = { t: "id" | "num" | "str" | "op" | "punc"; v: string };
const OPS2 = ["==", "!=", "<=", ">=", "&&", "||"];
const OPS1 = "<>!.(),";

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
  const isId = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      const q = c; let s = ""; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\" && i + 1 < src.length) { s += src[i + 1]; i += 2; continue; }
        s += src[i++];
      }
      if (src[i] !== q) throw new CelError("unterminated string");
      i++; toks.push({ t: "str", v: s }); continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let n = ""; while (i < src.length && /[0-9.]/.test(src[i]!)) n += src[i++];
      toks.push({ t: "num", v: n }); continue;
    }
    if (isIdStart(c)) {
      let id = ""; while (i < src.length && isId(src[i]!)) id += src[i++];
      toks.push({ t: "id", v: id }); continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) { toks.push({ t: "op", v: two }); i += 2; continue; }
    if (OPS1.includes(c)) { toks.push({ t: c === "(" || c === ")" || c === "," ? "punc" : "op", v: c }); i++; continue; }
    throw new CelError(`unexpected character '${c}'`);
  }
  return toks;
}

// ── Parser (|| < && < comparison < unary ! < postfix . / call) ──────────────
type Node =
  | { k: "id"; name: string }
  | { k: "lit"; value: string | number | boolean }
  | { k: "member"; obj: Node; prop: string }
  | { k: "call"; fn: string; args: Node[] }
  | { k: "method"; recv: Node; name: string; args: Node[] }
  | { k: "unary"; op: string; arg: Node }
  | { k: "binary"; op: string; l: Node; r: Node };

class Parser {
  i = 0;
  constructor(private toks: Tok[]) {}
  private peek() { return this.toks[this.i]; }
  private next() { return this.toks[this.i++]; }
  private eat(v: string) { const t = this.next(); if (!t || t.v !== v) throw new CelError(`expected '${v}', got '${t?.v ?? "EOF"}'`); }
  parse(): Node { const n = this.or(); if (this.i < this.toks.length) throw new CelError(`trailing tokens at '${this.peek()?.v}'`); return n; }
  private or(): Node { let l = this.and(); while (this.peek()?.v === "||") { this.next(); l = { k: "binary", op: "||", l, r: this.and() }; } return l; }
  private and(): Node { let l = this.cmp(); while (this.peek()?.v === "&&") { this.next(); l = { k: "binary", op: "&&", l, r: this.cmp() }; } return l; }
  private cmp(): Node {
    const l = this.unary(); const op = this.peek()?.v;
    if (op && ["==", "!=", "<=", ">=", "<", ">"].includes(op)) { this.next(); return { k: "binary", op, l, r: this.unary() }; }
    return l;
  }
  private unary(): Node { if (this.peek()?.v === "!") { this.next(); return { k: "unary", op: "!", arg: this.unary() }; } return this.postfix(); }
  private postfix(): Node {
    let n = this.primary();
    for (;;) {
      if (this.peek()?.v === ".") {
        this.next(); const name = this.next();
        if (name?.t !== "id") throw new CelError("expected member name after '.'");
        if (this.peek()?.v === "(") n = { k: "method", recv: n, name: name.v, args: this.args() };
        else n = { k: "member", obj: n, prop: name.v };
      } else break;
    }
    return n;
  }
  private args(): Node[] { this.eat("("); const a: Node[] = []; if (this.peek()?.v !== ")") { a.push(this.or()); while (this.peek()?.v === ",") { this.next(); a.push(this.or()); } } this.eat(")"); return a; }
  private primary(): Node {
    const t = this.next();
    if (!t) throw new CelError("unexpected EOF");
    if (t.v === "(") { const n = this.or(); this.eat(")"); return n; }
    if (t.t === "num") return { k: "lit", value: Number(t.v) };
    if (t.t === "str") return { k: "lit", value: t.v };
    if (t.t === "id") {
      if (t.v === "true") return { k: "lit", value: true };
      if (t.v === "false") return { k: "lit", value: false };
      if (this.peek()?.v === "(") return { k: "call", fn: t.v, args: this.args() };
      return { k: "id", name: t.v };
    }
    throw new CelError(`unexpected token '${t.v}'`);
  }
}

// ── Evaluator (gap relocated from op-tree to CEL nodes; formulas preserved) ──

/** Dotted path for `a.b.c`; inside a filter/exists/all body the bound var is
 *  stripped (`j.status` → `status`, bare `j` → "" = the element itself). */
function pathOf(n: Node, bound?: string): string {
  if (n.k === "id") return bound && n.name === bound ? "" : n.name;
  if (n.k === "member") { const base = pathOf(n.obj, bound); return base ? `${base}.${n.prop}` : n.prop; }
  throw new CelError(`expected a field path, got ${n.k}`);
}
function litOf(n: Node): string | number | boolean { if (n.k !== "lit") throw new CelError("expected a literal value"); return n.value; }
function val(scene: unknown, n: Node, bound?: string): unknown { return n.k === "lit" ? n.value : resolve(scene, pathOf(n, bound)); }

/** `coll.size()` or `coll.filter(v,p).size()` → the live count, or null. */
function sizeOf(n: Node, scene: unknown, bound?: string): { count: number; desc: string } | null {
  if (n.k !== "method" || n.name !== "size" || n.args.length !== 0) return null;
  const recv = n.recv;
  if (recv.k === "method" && recv.name === "filter") {
    const [v, pred] = recv.args;
    if (v?.k !== "id" || !pred) throw new CelError("filter(v, pred) expected");
    const coll = resolve(scene, pathOf(recv.recv, bound));
    const count = Array.isArray(coll) ? coll.filter(el => evalGap(el, pred, v.name).pass).length : NaN;
    return { count, desc: `${pathOf(recv.recv, bound)}.filter(…)` };
  }
  const coll = resolve(scene, pathOf(recv, bound));
  return { count: Array.isArray(coll) ? coll.length : NaN, desc: pathOf(recv, bound) };
}

function evalGap(scene: unknown, n: Node, bound?: string): CheckResult {
  switch (n.k) {
    case "binary": {
      if (n.op === "&&") {
        const sub = [evalGap(scene, n.l, bound), evalGap(scene, n.r, bound)];
        const fail = sub.find(r => !r.pass);
        return { pass: !fail, gap: sub.reduce((s, r) => s + r.gap, 0), why: fail?.why ?? "all hold" };
      }
      if (n.op === "||") {
        const sub = [evalGap(scene, n.l, bound), evalGap(scene, n.r, bound)];
        const win = sub.find(r => r.pass);
        return { pass: !!win, gap: win ? 0 : Math.min(...sub.map(r => r.gap)), why: win?.why ?? "neither branch holds" };
      }
      // comparison — left may be a .size() (→ count) or a path
      const sz = sizeOf(n.l, scene, bound);
      if (sz) {
        const target = Number(litOf(n.r));
        if (!Number.isFinite(sz.count)) return { pass: false, gap: 1, why: `${sz.desc}: not a collection` };
        const c = sz.count;
        const mk = (ok: boolean, gap: number, rel: string): CheckResult => ({ pass: ok, gap, why: `${sz.desc}: count=${c}, expected ${rel}` });
        switch (n.op) {
          case "==": return mk(c === target, Math.abs(c - target), `= ${target}`);
          case ">=": return mk(c >= target, Math.max(0, target - c), `≥ ${target}`);
          case "<=": return mk(c <= target, Math.max(0, c - target), `≤ ${target}`);
          case ">":  return mk(c > target,  Math.max(0, target + 1 - c), `> ${target}`);
          case "<":  return mk(c < target,  Math.max(0, c - (target - 1)), `< ${target}`);
          default: throw new CelError(`unsupported size comparison '${n.op}'`);
        }
      }
      const path = pathOf(n.l, bound);
      const v = resolve(scene, path);
      const lit = litOf(n.r);
      switch (n.op) {
        case "==": return deepEq(v, lit) ? { pass: true, gap: 0, why: `${path} = ${json(v)}` } : { pass: false, gap: 1, why: `${path}: expected ${json(lit)}, got ${json(v)}` };
        case "!=": return !deepEq(v, lit) ? { pass: true, gap: 0, why: `${path} ≠ ${json(lit)}` } : { pass: false, gap: 1, why: `${path}: expected ≠ ${json(lit)}` };
        case "<=": case "<": { if (typeof v !== "number") return { pass: false, gap: 1, why: `${path}: expected number ${n.op} ${lit}, got ${json(v)}` }; const t = Number(lit); const ok = n.op === "<=" ? v <= t : v < t; const g = Math.max(0, v - t); return ok ? { pass: true, gap: 0, why: `${path} = ${v} ${n.op} ${lit}` } : { pass: false, gap: g, why: `${path}: expected ${n.op} ${lit}, got ${v} (over by ${g})` }; }
        case ">=": case ">": { if (typeof v !== "number") return { pass: false, gap: 1, why: `${path}: expected number ${n.op} ${lit}, got ${json(v)}` }; const t = Number(lit); const ok = n.op === ">=" ? v >= t : v > t; const g = Math.max(0, t - v); return ok ? { pass: true, gap: 0, why: `${path} = ${v} ${n.op} ${lit}` } : { pass: false, gap: g, why: `${path}: expected ${n.op} ${lit}, got ${v} (short by ${g})` }; }
        default: throw new CelError(`'${n.op}' on a value has no gap`);
      }
    }
    case "unary":
      if (n.op === "!") {
        if (n.arg.k === "call" && n.arg.fn === "has") { const p = pathOf(n.arg.args[0]!, bound); return resolve(scene, p) === undefined ? { pass: true, gap: 0, why: `${p}: absent` } : { pass: false, gap: 1, why: `${p}: expected absent` }; }
        const r = evalGap(scene, n.arg, bound);
        return r.pass ? { pass: false, gap: 1, why: `negated condition held` } : { pass: true, gap: 0, why: `negated condition did not hold` };
      }
      throw new CelError(`unsupported unary '${n.op}'`);
    case "call":
      if (n.fn === "has" && n.args.length === 1) { const p = pathOf(n.args[0]!, bound); return resolve(scene, p) !== undefined ? { pass: true, gap: 0, why: `${p} present` } : { pass: false, gap: 1, why: `${p}: missing` }; }
      throw new CelError(`unsupported function '${n.fn}()'`);
    case "method": {
      if (n.name === "contains" && n.args.length === 1) {
        const path = pathOf(n.recv, bound); const v = resolve(scene, path); const sub = String(litOf(n.args[0]!));
        if (typeof v !== "string") return { pass: false, gap: 1, why: `${path}: expected string containing "${sub}", got ${json(v)}` };
        return v.includes(sub) ? { pass: true, gap: 0, why: `${path} contains "${sub}"` } : { pass: false, gap: 1, why: `${path}: "${sub}" not found` };
      }
      if (n.name === "exists" && n.args.length === 2) {
        const [v, pred] = n.args; if (v?.k !== "id" || !pred) throw new CelError("exists(v, pred) expected");
        const coll = resolve(scene, pathOf(n.recv, bound));
        if (!Array.isArray(coll)) return { pass: false, gap: 1, why: `${pathOf(n.recv, bound)}: not a collection` };
        let best: CheckResult | undefined;
        for (const el of coll) { const r = evalGap(el, pred, v.name); if (r.pass) return { pass: true, gap: 0, why: r.why }; if (!best || r.gap < best.gap) best = r; }
        return { pass: false, gap: best ? Math.max(1, best.gap) : 1, why: `no element matched${best ? ` (closest: ${best.why})` : ""}` };
      }
      if (n.name === "all" && n.args.length === 2) {
        const [v, pred] = n.args; if (v?.k !== "id" || !pred) throw new CelError("all(v, pred) expected");
        const coll = resolve(scene, pathOf(n.recv, bound));
        if (!Array.isArray(coll)) return { pass: false, gap: 1, why: `${pathOf(n.recv, bound)}: not a collection` };
        const bad = coll.filter(el => !evalGap(el, pred, v.name).pass).length;
        return { pass: bad === 0, gap: bad, why: bad === 0 ? "all elements satisfy" : `${bad} element(s) violate` };
      }
      throw new CelError(`unsupported method '.${n.name}()' (or it needs a comparison, e.g. .size() >= 3)`);
    }
    case "member":
    case "id": {
      // bare boolean field, e.g. note.has_content
      const path = pathOf(n, bound); const v = resolve(scene, path);
      return v === true ? { pass: true, gap: 0, why: `${path} is true` } : { pass: false, gap: 1, why: `${path}: expected true, got ${json(v)}` };
    }
    case "lit":
      throw new CelError("a bare literal is not a predicate");
  }
}

/** Evaluate a CEL predicate against a scene → { pass, gap, why }. */
export function runCheck(scene: unknown, cel: string): CheckResult {
  return evalGap(scene, new Parser(lex(cel)).parse());
}

/** True if `cel` parses to a gap-able predicate (else route to the judge). */
export function isGapable(cel: string): boolean {
  try { runCheck({}, cel); return true; } catch (e) { return !(e instanceof CelError); }
}

// ── tiny helpers ────────────────────────────────────────────────────────────
function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  if (typeof a === "object") { const ak = Object.keys(a as object), bk = Object.keys(b as object); return ak.length === bk.length && ak.every(k => deepEq((a as any)[k], (b as any)[k])); }
  return false;
}
function json(v: unknown): string { if (v === undefined) return "undefined"; try { const s = JSON.stringify(v); return s.length > 60 ? s.slice(0, 57) + "…" : s; } catch { return String(v); } }
