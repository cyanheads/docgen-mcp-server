---
name: docgen-guide
description: Use docgen_* to inspect an AcroForm, verify the filled values, and flatten the reviewed PDF for delivery. Also use when retrieving a generated document whose bytes were omitted from the tool response.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Identifiers

- Carry the exact names from `docgen_list_form_fields` into `docgen_fill_form`, including parent paths. Use labels and widget pages to distinguish fields with similar names.
- Each `docgen_fill_form`, `docgen_render_pdf`, and `docgen_export_spreadsheet` result has a fresh `documentId` for `docgen_get_document` and a `resourceUri` for reading the artifact. Form inspection and filling take PDF bytes or a supported source URL.

## Gates

- If inspection returns `not_a_form`, ask for the fillable AcroForm original. Leave signature and button fields to the user.
- Before calling a fill complete, resolve every unmatched assignment, check that accepted aliases point to the intended fields, and review any checkbox or dropdown notices. A fill can succeed with an omitted required field, an unrecognized checkbox value can leave the box unchecked, and custom dropdown text can make a fixed dropdown editable.
- Before flattening, compare the saved values with the intended values and check required fields for omissions. Keep an editable copy if further changes are expected.

## Core chain

1. Inspect the original with `docgen_list_form_fields`. Fill with the reported names and constraints, leaving the result editable. Use booleans for checkbox intent and listed choices when the value must stay within the form's options. If the source URL can change, use the same PDF bytes for inspection and filling.
2. Reconcile the fill report. For `invalid_field_value`, correct the reported assignments and retry. For unmatched keys or unintended changes, correct the field map and fill again from the original.
3. Read the filled PDF's base64 from `inlineBase64` or from the blob at `resourceUri`. Pass that base64 to `docgen_list_form_fields` and compare the stored values by exact field name. Check the intended checkbox states and selected choices.
4. If the user needs a flattened copy, pass the reviewed PDF bytes to `docgen_fill_form` with an empty assignment map and flattening enabled. Deliver this new artifact. Field inspection on the flattened copy returns `not_a_form`.

## Workflows

- **Deliver a document.** Read the bytes while the artifact is available. When inline bytes are omitted, read the returned resource URI. `docgen_get_document` re-fetches the envelope under the same inline limit. If the artifact expires, repeat the originating operation and use the new result.
- **Render a report.** If `docgen_render_pdf` reports `degraded`, review the PDF for lost styling or replacement characters before delivery. Simplify the source and render again if the loss affects the requested result.
