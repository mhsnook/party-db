import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import * as zm from 'zod/mini'
import { assertIdent, columnsOf, decode, decodeRow, encode } from '../src/server/columns.ts'

describe('columnsOf (schema → injection-safe allowlist + codec)', () => {
  it('reads a zod object into column names + codec kinds, unwrapping modifiers', () => {
    const schema = z.object({
      id: z.string(),
      text: z.string(),
      done: z.boolean(),
      meta: z.object({ a: z.number() }).optional(),
      tags: z.array(z.string()),
      dict: z.record(z.string(), z.number()).nullable(),
      pair: z.tuple([z.string(), z.number()]),
      flag: z.boolean().default(false),
      n: z.number().int().nullable().default(0),
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
  it('unwraps a transform pipe from either side', () => {
    expect(columnsOf(z.object({ a: z.boolean().transform((v) => v) }))).toEqual([
      { name: 'a', kind: 'boolean' },
    ])
    expect(columnsOf(z.object({ a: z.preprocess((v) => v, z.array(z.string())) }))).toEqual([
      { name: 'a', kind: 'json' },
    ])
  })

  // zod/mini builds the same `_zod.def` nodes, so it reads identically. We do not
  // advertise it; this is here so a mini user is not silently dropped to blob.
  it('reads a zod/mini object the same way', () => {
    const schema = zm.object({
      id: zm.string(),
      done: zm.boolean(),
      tags: zm.array(zm.string()),
      flag: zm.optional(zm.boolean()),
    })
    expect(columnsOf(schema)).toEqual([
      { name: 'id', kind: 'scalar' },
      { name: 'done', kind: 'boolean' },
      { name: 'tags', kind: 'json' },
      { name: 'flag', kind: 'boolean' },
    ])
  })

  // A v3 schema has no `_zod`, so it would otherwise look like any other opaque
  // StandardSchema and drop the collection into the blob store (issue #45 in
  // reverse). Fail at boot with the version named instead. Zod 3 is no longer a
  // devDependency, so this is a hand-built stand-in for its node layout.
  it('rejects a zod v3 schema by name instead of falling back to blob', () => {
    const v3Object = {
      _def: {
        typeName: 'ZodObject',
        shape: () => ({ id: { _def: { typeName: 'ZodString' } } }),
      },
      get shape() {
        return this._def.shape()
      },
    } as any
    expect(() => columnsOf(v3Object)).toThrow(/Zod v3 \(ZodObject\)/)
    expect(() => columnsOf(v3Object, 'todos')).toThrow(/collection "todos"/)
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
