/**
 * @fileoverview Resolves AcroForm assignments and validates the values and appearances they change.
 * @module services/document/form-assignments
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  cleanText,
  mergeLines,
  PDFCheckBox,
  PDFDropdown,
  type PDFField,
  type PDFFont,
  type PDFForm,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
} from 'pdf-lib';
import type { FormFields } from './render-types.js';

/** Reports the disposition of field assignments before the form is flattened. */
export interface FormAssignmentReport {
  madeEditableFields: string[];
  notices: string[];
  resolvedFields: { requested: string; resolved: string }[];
  unmatchedFields: string[];
}

type FieldIndex = Map<string, PDFField | null>;

function indexAlias(index: FieldIndex, alias: string, field: PDFField): void {
  index.set(alias, index.has(alias) ? null : field);
}

/** Mutates a loaded form. Invalid values abort the fill before saving or storing any document. */
export function applyFormAssignments(
  form: PDFForm,
  fields: FormFields,
  ctx: Context,
): FormAssignmentReport {
  const exact = new Map<string, PDFField>();
  const folded: FieldIndex = new Map();
  const leaves: FieldIndex = new Map();
  for (const field of form.getFields()) {
    const name = field.getName();
    if (!exact.has(name)) exact.set(name, field);
    indexAlias(folded, name.toLowerCase(), field);
    indexAlias(leaves, name.slice(name.lastIndexOf('.') + 1), field);
  }

  const entries = Object.entries(fields);
  const aliases: FieldIndex = new Map();
  const candidates = new Map<string, PDFField>();
  for (const [requested] of entries) {
    if (exact.has(requested)) continue;
    const leaf = leaves.get(requested);
    const full = folded.get(requested.toLowerCase());
    if (leaf === null || full === null || (leaf && full && leaf !== full)) continue;
    const field = leaf ?? full;
    if (!field) continue;
    const resolved = field.getName();
    if (Object.hasOwn(fields, resolved)) continue;
    indexAlias(aliases, resolved, field);
    candidates.set(requested, field);
  }

  const report: FormAssignmentReport = {
    unmatchedFields: [],
    resolvedFields: [],
    madeEditableFields: [],
    notices: [],
  };
  const failures: string[] = [];
  let appearanceFont: PDFFont | undefined;
  for (const [requested, value] of entries) {
    const field = exact.get(requested) ?? candidates.get(requested);
    if (!field) {
      report.unmatchedFields.push(requested);
      continue;
    }
    const name = field.getName();
    if (requested !== name) {
      if (aliases.get(name) === null) {
        report.unmatchedFields.push(requested);
        continue;
      }
      report.resolvedFields.push({ requested, resolved: name });
    }
    let failure = applyFieldValue(field, name, value, report);
    if (failure === undefined && (field instanceof PDFTextField || field instanceof PDFDropdown)) {
      appearanceFont ??= assignmentAppearanceFont(form.getDefaultFont());
      try {
        field.defaultUpdateAppearances(appearanceFont);
      } catch (error) {
        if (!(error instanceof UnsupportedAppearanceGlyph)) throw error;
        failure = error.message;
      }
    }
    if (failure !== undefined) failures.push(`${JSON.stringify(name)}: ${failure}`);
  }

  if (failures.length > 0) {
    throw validationError(`Invalid form field values:\n${failures.join('\n')}`, {
      reason: 'invalid_field_value',
      ...ctx.recoveryFor('invalid_field_value'),
    });
  }
  return report;
}

const CHECKED = new Set(['true', '1', 'yes', 'on', 'x', 'checked']);
const UNCHECKED = new Set(['false', '0', 'no', 'off', 'unchecked', '']);

function applyFieldValue(
  field: PDFField,
  name: string,
  value: FormFields[string],
  report: FormAssignmentReport,
): string | undefined {
  const text = String(value);
  if (field instanceof PDFCheckBox) {
    const onValue = field.acroField.getOnValue()?.decodeText();
    const normalized = text.trim().toLowerCase();
    if (typeof value === 'boolean') {
      if (value) field.check();
      else field.uncheck();
    } else if (
      value === onValue ||
      CHECKED.has(normalized) ||
      (!UNCHECKED.has(normalized) && normalized === onValue?.trim().toLowerCase())
    ) {
      field.check();
    } else {
      field.uncheck();
      if (!UNCHECKED.has(normalized)) {
        report.notices.push(
          `Unchecked ${JSON.stringify(name)} because ${JSON.stringify(value)} is an unrecognized checkbox value.`,
        );
      }
    }
  } else if (field instanceof PDFTextField) {
    const maxLength = field.getMaxLength();
    if (maxLength !== undefined && text && text.length > maxLength) {
      return `Text has length ${text.length} and exceeds the maximum length of ${maxLength}.`;
    }
    field.setText(text);
    if (
      maxLength !== undefined &&
      maxLength > 0 &&
      field.isCombed() &&
      field.acroField.getWidgets().length > 0 &&
      mergeLines(cleanText(field.getText() ?? '')).length > maxLength
    ) {
      return `Text must fit ${maxLength} cells after tabs and line breaks are expanded.`;
    }
  } else if (field instanceof PDFDropdown) {
    const wasEditable = field.isEditable();
    // pdf-lib enables editing for a truthy custom value and rejects an unlisted empty string.
    if (!wasEditable && text === '' && !field.getOptions().includes(text)) {
      return 'Choose a listed option or enter nonempty custom text.';
    }
    field.select(text);
    if (!wasEditable && field.isEditable()) {
      report.madeEditableFields.push(name);
      report.notices.push(
        `Made ${JSON.stringify(name)} editable to enter ${JSON.stringify(text)}.`,
      );
    }
  } else if (field instanceof PDFRadioGroup || field instanceof PDFOptionList) {
    const options = field.getOptions();
    const normalized = text.toLowerCase();
    const matches = options.includes(text)
      ? [text]
      : [...new Set(options.filter((option) => option.toLowerCase() === normalized))];
    const [match] = matches;
    if (match === undefined || matches.length > 1) {
      return `Choose one of ${JSON.stringify(options)}. The value ${JSON.stringify(text)} ${matches.length ? 'matches multiple choices' : 'matches no choice'}.`;
    }
    field.select(match);
  } else {
    return 'This field is discovery only and cannot be filled.';
  }
  return undefined;
}

class UnsupportedAppearanceGlyph extends Error {}

/**
 * Classifies encoding failures on the strings pdf-lib actually sends to the font.
 * Its WinAnsi encoder throws a plain Error, and the layout prepares different text
 * for single-line, multiline and combed widgets.
 */
function assignmentAppearanceFont(font: PDFFont): PDFFont {
  let supported: ReadonlySet<number | undefined> | undefined;
  function encode<T>(text: string, operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      supported ??= new Set(font.getCharacterSet());
      for (const character of text) {
        if (!supported.has(character.codePointAt(0))) {
          throw new UnsupportedAppearanceGlyph(
            `The PDF widget font cannot display ${JSON.stringify(character)}.`,
            { cause: error },
          );
        }
      }
      throw error;
    }
  }
  return Object.assign(Object.create(font) as PDFFont, {
    encodeText: (text: string) => encode(text, () => font.encodeText(text)),
    widthOfTextAtSize: (text: string, size: number) =>
      encode(text, () => font.widthOfTextAtSize(text, size)),
  });
}
