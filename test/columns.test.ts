import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { assertIdent, columnsOf, decode, decodeRow, encode } from '../src/server/columns.ts'

describe('columnsOf (schema → injection-safe allowlist + codec)', () => {
  it('reads a zod object into column names + codec kinds, unwrapping modifiers', () => {
    const schema = z.object({
      id: z.string(),
      text: z.string(),
      done: z.boolean(),
      meta: z.object({ a: z.number() }).optional(),
      tags: z.array(z.string()),
      n: z.number().int().nullable().default(0),
    })
    expect(columnsOf(schema)).toEqual([
      { name: 'id', kind: 'scalar' },
      { name: 'text', kind: 'scalar' },
      { name: 'done', kind: 'boolean' },
      { name: 'meta', kind: 'json' },
      { name: 'tags', kind: 'json' },
      { name: 'n', kind: 'scalar' },
    ])
  })

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
