import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { z as z4 } from 'zod/v4'
import { assertIdent, columnsOf, decode, decodeRow, encode } from '../src/server/columns.ts'

describe('columnsOf (schema → injection-safe allowlist + codec)', () => {
  // v3 and v4 build these schemas with the same calls; only the private `_def`
  // shape differs, and reading the wrong one classifies every column as `scalar` —
  // a boolean comes back as 0/1 and a json column as unparsed text (issue #45).
  // The cast is load-bearing: a bare union of the two namespaces is not callable.
  const versions: [string, typeof z4][] = [
    ['v3', z as unknown as typeof z4],
    ['v4', z4],
  ]

  for (const [label, zz] of versions) {
    it(`reads a zod ${label} object into column names + codec kinds, unwrapping modifiers`, () => {
      const schema = zz.object({
        id: zz.string(),
        text: zz.string(),
        done: zz.boolean(),
        meta: zz.object({ a: zz.number() }).optional(),
        tags: zz.array(zz.string()),
        dict: zz.record(zz.string(), zz.number()).nullable(),
        pair: zz.tuple([zz.string(), zz.number()]),
        flag: zz.boolean().default(false),
        n: zz.number().int().nullable().default(0),
      })
      expect(columnsOf(schema)).toEqual([
        { name: 'id', kind: 'scalar' },
        { name: 'text', kind: 'scalar' },
        { name: 'done', kind: 'boolean' },
        { name: 'meta', kind: 'json' },
        { name: 'tags', kind: 'json' },
        { name: 'dict', kind: 'json' },
        { name: 'pair', kind: 'json' },
        { name: 'flag', kind: 'boolean' },
        { name: 'n', kind: 'scalar' },
      ])
    })

    // `.transform()` leaves the base type on the pipe's input side, `z.preprocess()`
    // on its output side. Either way we want the base type, not the transform.
    it(`unwraps a zod ${label} transform pipe from either side`, () => {
      expect(columnsOf(zz.object({ a: zz.boolean().transform((v) => v) }))).toEqual([
        { name: 'a', kind: 'boolean' },
      ])
      expect(columnsOf(zz.object({ a: zz.preprocess((v) => v, zz.array(zz.string())) }))).toEqual([
        { name: 'a', kind: 'json' },
      ])
    })
  }

  it('returns null for a schema it cannot introspect (→ blob fallback)', () => {
    expect(columnsOf(undefined)).toBeNull()
    // a StandardSchema that is not a zod object (no .shape)
    const opaque = { '~standard': { version: 1, vendor: 'x', validate: (v: unknown) => ({ value: v }) } } as any
    expect(columnsOf(opaque)).toBeNull()
  })

  it('rejects a schema whose key is not a safe SQL identifier', () => {
    const evil = z.object({ 'id; DROP TABLE x': z.string() })
    expect(() => columnsOf(evil)).toThrow(/unsafe SQL identifier/)
  })
})

describe('assertIdent', () => {
  it('accepts ordinary identifiers', () => {
    for (const ok of ['id', '_x', 'col_1', 'Todo']) expect(assertIdent(ok)).toBe(ok)
  })
  it('rejects anything with spaces, punctuation, or a leading digit', () => {
    for (const bad of ['', '1col', 'a b', 'a-b', 'a;b', 'a)b', '"a"']) {
      expect(() => assertIdent(bad)).toThrow(/unsafe SQL identifier/)
    }
  })
})

describe('encode (JS value → SQLite-bindable)', () => {
  it('maps booleans to 0/1', () => {
    expect(encode(true)).toBe(1)
    expect(encode(false)).toBe(0)
  })
  it('JSON-stringifies objects and arrays', () => {
    expect(encode({ a: 1 })).toBe('{"a":1}')
    expect(encode([1, 2])).toBe('[1,2]')
  })
  it('passes strings and numbers through, and nullifies undefined/null', () => {
    expect(encode('hi')).toBe('hi')
    expect(encode(42)).toBe(42)
    expect(encode(undefined)).toBeNull()
    expect(encode(null)).toBeNull()
  })
})

describe('decode (SQLite value → schema shape)', () => {
  it('turns 0/1 back into booleans for boolean columns', () => {
    expect(decode(1, 'boolean')).toBe(true)
    expect(decode(0, 'boolean')).toBe(false)
  })
  it('parses JSON for json columns', () => {
    expect(decode('{"a":1}', 'json')).toEqual({ a: 1 })
  })
  it('passes scalars through and keeps null', () => {
    expect(decode('hi', 'scalar')).toBe('hi')
    expect(decode(null, 'boolean')).toBeNull()
  })
  it('decodeRow applies kinds per column and passes unknown columns through', () => {
    const kinds = new Map([
      ['done', 'boolean'],
      ['meta', 'json'],
    ] as const)
    expect(decodeRow({ id: 'a', done: 1, meta: '{"x":true}', extra: 7 }, kinds)).toEqual({
      id: 'a',
      done: true,
      meta: { x: true },
      extra: 7,
    })
  })
})
