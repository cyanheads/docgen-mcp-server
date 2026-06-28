/**
 * @fileoverview Render input value-type schemas shared between the write tools and
 * the RenderService — the PDF `source` union, `pageOptions`, spreadsheet `sheets[]`
 * and column spec, and the form-fill `fields` / `sourcePdf` shapes.
 * @module services/document/render-types
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Page-size and margin unit regex — a number followed by a CSS length unit. */
const LENGTH_RE = /^\d+(\.\d+)?(px|pt|mm|cm|in)$/;

/** A length string ("10mm", "0.5in", "72pt"), or empty string from form clients. */
const lengthString = (label: string) =>
  z.union([z.literal(''), z.string().regex(LENGTH_RE).describe(label)]).describe(label);

/**
 * The PDF render source — exactly one of HTML, markdown, or template+data. Mutual
 * exclusion is enforced in the handler (zero or multiple keys → `invalid_source`);
 * the schema keeps all three optional so a single missing/extra key produces the
 * typed domain error rather than a schema rejection.
 */
export const PdfSourceSchema = z
  .object({
    html: z
      .string()
      .optional()
      .describe('Raw HTML string; the full document markup composed by the caller.'),
    markdown: z
      .string()
      .optional()
      .describe('Markdown string; converted to HTML then rendered. Sugar over the html source.'),
    template: z
      .string()
      .optional()
      .describe('A Handlebars-style template string filled with `data`. Server owns layout.'),
    data: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Key/value data interpolated into `template`. Extra keys are ignored.'),
  })
  .describe(
    'The document source — provide exactly ONE of: { html }, { markdown }, or { template, data }.',
  );

export type PdfSource = z.infer<typeof PdfSourceSchema>;

/** Page-layout options for PDF rendering. */
export const PageOptionsSchema = z
  .object({
    size: z.enum(['A4', 'Letter', 'Legal', 'A3', 'A5']).default('Letter').describe('Page size.'),
    orientation: z
      .enum(['portrait', 'landscape'])
      .default('portrait')
      .describe('Page orientation.'),
    margin: z
      .object({
        top: lengthString('Top margin, e.g. "10mm".').optional(),
        right: lengthString('Right margin, e.g. "10mm".').optional(),
        bottom: lengthString('Bottom margin, e.g. "10mm".').optional(),
        left: lengthString('Left margin, e.g. "10mm".').optional(),
      })
      .optional()
      .describe('Page margins; each side is a CSS length like "10mm", "0.5in", or "72pt".'),
    header: z
      .string()
      .optional()
      .describe(
        'Optional header text. Supports tokens {{page}}, {{total}}, {{date}}, e.g. "Page {{page}} of {{total}}".',
      ),
    footer: z
      .string()
      .optional()
      .describe('Optional footer text. Supports the same {{page}} / {{total}} / {{date}} tokens.'),
    pageNumbers: z
      .boolean()
      .default(false)
      .describe('When true, render a "Page N of M" footer automatically.'),
  })
  .describe('Page layout options for the rendered PDF.');

export type PageOptions = z.infer<typeof PageOptionsSchema>;

/** A single spreadsheet cell value — a JSON-serializable scalar. */
export const CellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** Per-column formatting spec for a spreadsheet sheet. */
export const ColumnSpecSchema = z
  .object({
    key: z.string().describe('Row-object property name this column reads from.'),
    header: z.string().describe('Display label for the column header cell.'),
    type: z
      .enum(['string', 'number', 'date', 'boolean'])
      .default('string')
      .describe('Cell value type. `date` expects ISO 8601 string row values.'),
    width: z.number().positive().optional().describe('Column width in character units.'),
    format: z
      .string()
      .optional()
      .describe('Excel number/date format string, e.g. "#,##0.00" or "yyyy-mm-dd".'),
  })
  .describe('Formatting spec for one spreadsheet column.');

export type ColumnSpec = z.infer<typeof ColumnSpecSchema>;

/** A single named worksheet of row objects. */
export const SheetSchema = z
  .object({
    name: z
      .string()
      .describe(
        'Worksheet name (the tab label). Excel constraints: 1–31 characters, unique across the workbook (case-insensitive), no * ? : \\ / [ ] characters, and no leading or trailing apostrophe.',
      ),
    rows: z
      .array(z.record(z.string(), CellValueSchema))
      .describe('Row objects (property → scalar). An empty array produces a header-only sheet.'),
    columns: z
      .array(ColumnSpecSchema)
      .optional()
      .describe(
        'Optional ordered column spec. When omitted, columns derive from the first row keys.',
      ),
  })
  .describe('One named worksheet of tabular rows.');

export type Sheet = z.infer<typeof SheetSchema>;

/**
 * The source PDF for form filling — exactly one of base64 or a URL. Mutual
 * exclusion is enforced in the handler.
 */
export const SourcePdfSchema = z
  .object({
    base64: z
      .string()
      .optional()
      .describe(
        'The source PDF as a base64 string; line breaks/whitespace and an optional `data:application/pdf;base64,` prefix are tolerated. Avoids any network fetch.',
      ),
    url: z
      .string()
      .optional()
      .describe(
        'An https URL serving the source PDF. Fetched behind an SSRF guard; must be public and serve application/pdf.',
      ),
  })
  .describe('The fillable PDF source — provide exactly ONE of { base64 } or { url }.');

export type SourcePdf = z.infer<typeof SourcePdfSchema>;

/** AcroForm field name → value map. */
export const FormFieldsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .describe(
    'AcroForm field name → value. Names must match the PDF internal field names exactly (case-sensitive). Unmatched names are returned in unmatchedFields[].',
  );

export type FormFields = z.infer<typeof FormFieldsSchema>;
