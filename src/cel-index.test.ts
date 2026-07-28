/**
 * Index notation — reaching keys that aren't bare identifiers.
 *
 * JSON keys are arbitrary strings, but `a.b` only reaches the subset that
 * lexes as an identifier. Before index notation the tokenizer stopped at the
 * first `-`, which put a large slice of ordinary JSON out of reach: HTTP
 * header names, JSON Schema's `$ref`, JSON-LD's `@type`, kebab-case config
 * keys, and anything starting with a digit.
 */

import { describe, test, expect } from 'bun:test';
import { runCheck } from './index.js';

const STATE = {
  'content-type': 'application/json',
  'x-request-id': 'req-8f21',
  $ref: '#/components/schemas/Order',
  '@type': 'Invoice',
  '2xx': { count: 14 },
  'order-summary': {
    status: 'HOLD',
    lines: [{ sku: 'A-100', qty: 2 }, { sku: 'B-200', qty: 1 }],
    note: 'held pending receipt',
  },
  run: { errors: 0, cost_usd: 0.31 },
  rows: [{ amount: 425 }, { amount: 467.5 }],
  flag: true,
};

describe('keys that are not identifiers', () => {
  test('reaches a kebab-case key, the case that used to throw', () => {
    expect(runCheck(STATE, '["order-summary"].status == "HOLD"').pass).toBe(true);
  });

  test('chains through such a key into nested values', () => {
    expect(runCheck(STATE, '["order-summary"].note.contains("receipt")').pass).toBe(true);
    expect(runCheck(STATE, '["order-summary"].lines.size() == 2').pass).toBe(true);
  });

  test('reaches header, sigil and digit-leading keys', () => {
    expect(runCheck(STATE, '["content-type"].contains("json")').pass).toBe(true);
    expect(runCheck(STATE, '["x-request-id"] == "req-8f21"').pass).toBe(true);
    expect(runCheck(STATE, '["$ref"].contains("Order")').pass).toBe(true);
    expect(runCheck(STATE, '["@type"] == "Invoice"').pass).toBe(true);
    expect(runCheck(STATE, '["2xx"].count == 14').pass).toBe(true);
  });

  test('reports a real gap rather than passing vacuously', () => {
    const r = runCheck(STATE, '["order-summary"].status == "CLEAR"');
    expect(r.pass).toBe(false);
    expect(r.gap).toBeGreaterThan(0);
  });
});

describe('array positions', () => {
  test('addresses a position', () => {
    expect(runCheck(STATE, 'rows[0].amount == 425').pass).toBe(true);
    expect(runCheck(STATE, 'rows[1].amount == 467.5').pass).toBe(true);
  });

  test('a missing position fails instead of throwing', () => {
    expect(runCheck(STATE, 'rows[9].amount == 1').pass).toBe(false);
  });

  test('indexes through a non-identifier key', () => {
    expect(runCheck(STATE, '["order-summary"].lines[0].sku == "A-100"').pass).toBe(true);
  });
});

describe('what it still refuses, and says so', () => {
  test('a non-literal index is rejected with guidance', () => {
    expect(() => runCheck(STATE, 'rows[foo].amount == 1')).toThrow(/quoted key or a number/);
  });

  test('a key containing path punctuation is rejected, not silently mis-resolved', () => {
    expect(() => runCheck(STATE, '["a.b"] == 1')).toThrow(/cannot express/);
  });
});

describe('existing syntax is unaffected', () => {
  test('dot paths, comparisons, size and compose still work', () => {
    expect(runCheck(STATE, 'run.errors == 0').pass).toBe(true);
    expect(runCheck(STATE, 'run.cost_usd <= 0.75').pass).toBe(true);
    expect(runCheck(STATE, 'rows.size() == 2').pass).toBe(true);
    expect(runCheck(STATE, 'flag').pass).toBe(true);
    expect(runCheck(STATE, 'run.errors == 0 && rows.size() == 2').pass).toBe(true);
  });
});
