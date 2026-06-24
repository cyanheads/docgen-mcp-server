/**
 * @fileoverview Input-schema validation tests — the Zod gates on the render/export/
 * fill inputs (page size & orientation enums, margin CSS-length regex, column type
 * enum and positive width, cell-value union). These are the schema rejections that
 * fire BEFORE a handler runs, so they are asserted against the schemas directly.
 * @module tests/services/render-types
 */

import { describe, expect, it } from 'vitest';
import {
  CellValueSchema,
  ColumnSpecSchema,
  PageOptionsSchema,
  SheetSchema,
} from '@/services/document/render-types.js';

describe('PageOptionsSchema', () => {
  it('applies defaults for size, orientation, and pageNumbers', () => {
    const parsed = PageOptionsSchema.parse({});
    expect(parsed.size).toBe('Letter');
    expect(parsed.orientation).toBe('portrait');
    expect(parsed.pageNumbers).toBe(false);
  });

  it('accepts every supported page size', () => {
    for (const size of ['A4', 'Letter', 'Legal', 'A3', 'A5'] as const) {
      expect(PageOptionsSchema.parse({ size }).size).toBe(size);
    }
  });

  it('rejects an unsupported page size', () => {
    expect(() => PageOptionsSchema.parse({ size: 'B5' })).toThrow();
    expect(() => PageOptionsSchema.parse({ size: 'letter' })).toThrow(); // case-sensitive enum
  });

  it('rejects an unsupported orientation', () => {
    expect(() => PageOptionsSchema.parse({ orientation: 'sideways' })).toThrow();
  });

  it('accepts valid CSS-length margins in each unit', () => {
    const parsed = PageOptionsSchema.parse({
      margin: { top: '10mm', right: '0.5in', bottom: '72pt', left: '2cm' },
    });
    expect(parsed.margin).toEqual({ top: '10mm', right: '0.5in', bottom: '72pt', left: '2cm' });
  });

  it('rejects a margin with no unit', () => {
    expect(() => PageOptionsSchema.parse({ margin: { top: '10' } })).toThrow();
  });

  it('rejects a margin with an unsupported unit', () => {
    expect(() => PageOptionsSchema.parse({ margin: { top: '10em' } })).toThrow();
    expect(() => PageOptionsSchema.parse({ margin: { top: '10%' } })).toThrow();
  });

  it('rejects a non-numeric margin', () => {
    expect(() => PageOptionsSchema.parse({ margin: { top: 'wide' } })).toThrow();
  });

  it('accepts an empty-string margin (form-client payload)', () => {
    // Form clients submit the full object shape with empty inner strings.
    const parsed = PageOptionsSchema.parse({
      margin: { top: '', right: '', bottom: '', left: '' },
    });
    expect(parsed.margin).toEqual({ top: '', right: '', bottom: '', left: '' });
  });

  it('accepts header and footer token strings', () => {
    const parsed = PageOptionsSchema.parse({
      header: 'Page {{page}} of {{total}}',
      footer: 'Generated {{date}}',
    });
    expect(parsed.header).toContain('{{page}}');
    expect(parsed.footer).toContain('{{date}}');
  });
});

describe('ColumnSpecSchema', () => {
  it('defaults the column type to string', () => {
    expect(ColumnSpecSchema.parse({ key: 'a', header: 'A' }).type).toBe('string');
  });

  it('accepts every supported column type', () => {
    for (const type of ['string', 'number', 'date', 'boolean'] as const) {
      expect(ColumnSpecSchema.parse({ key: 'a', header: 'A', type }).type).toBe(type);
    }
  });

  it('rejects an unsupported column type', () => {
    expect(() => ColumnSpecSchema.parse({ key: 'a', header: 'A', type: 'currency' })).toThrow();
  });

  it('rejects a non-positive column width', () => {
    expect(() => ColumnSpecSchema.parse({ key: 'a', header: 'A', width: 0 })).toThrow();
    expect(() => ColumnSpecSchema.parse({ key: 'a', header: 'A', width: -5 })).toThrow();
  });

  it('requires both key and header', () => {
    expect(() => ColumnSpecSchema.parse({ header: 'A' })).toThrow();
    expect(() => ColumnSpecSchema.parse({ key: 'a' })).toThrow();
  });
});

describe('CellValueSchema', () => {
  it('accepts scalars and null', () => {
    for (const v of ['x', 42, true, null]) {
      expect(CellValueSchema.parse(v)).toBe(v);
    }
  });

  it('rejects nested objects and arrays as cell values', () => {
    expect(() => CellValueSchema.parse({ nested: 1 })).toThrow();
    expect(() => CellValueSchema.parse([1, 2])).toThrow();
  });
});

describe('SheetSchema', () => {
  it('accepts a sheet with an empty rows array (header-only)', () => {
    const parsed = SheetSchema.parse({ name: 'Empty', rows: [] });
    expect(parsed.rows).toEqual([]);
  });

  it('requires a name and a rows array', () => {
    expect(() => SheetSchema.parse({ rows: [] })).toThrow();
    expect(() => SheetSchema.parse({ name: 'X' })).toThrow();
  });

  it('rejects a row whose value is a non-scalar', () => {
    expect(() => SheetSchema.parse({ name: 'X', rows: [{ a: { deep: 1 } }] })).toThrow();
  });
});
