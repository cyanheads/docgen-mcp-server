/**
 * @fileoverview Read-only inventory of AcroForm fields, constraints and stored values.
 * @module services/document/form-inventory
 */

import {
  PDFArray,
  PDFButton,
  PDFCheckBox,
  PDFDict,
  type PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFString,
  PDFTextField,
} from 'pdf-lib';

/** Field metadata and values that the PDF defines. Page numbers are one-based. */
export interface FormFieldInfo {
  label?: string;
  maxLength?: number;
  name: string;
  onValue?: string;
  options?: string[];
  page?: number;
  required: boolean;
  type: 'text' | 'checkbox' | 'dropdown' | 'optionList' | 'radioGroup' | 'signature' | 'button';
  value?: string | boolean | string[];
}

/** Reads fields and their first widget's page without regenerating appearances. */
export function inventoryFormFields(pdf: PDFDocument): FormFieldInfo[] {
  const pages = pdf.getPages();
  const pagesByRef = new Map(pages.map((page, index) => [page.ref, index + 1]));
  const pagesByAnnotation = new Map<PDFDict, number>();
  for (const [index, page] of pages.entries()) {
    const annotations = page.node.lookup(PDFName.of('Annots'));
    if (!(annotations instanceof PDFArray)) continue;
    for (let i = 0; i < annotations.size(); i++) {
      const annotation = annotations.lookup(i);
      if (annotation instanceof PDFDict && !pagesByAnnotation.has(annotation)) {
        pagesByAnnotation.set(annotation, index + 1);
      }
    }
  }

  return pdf
    .getForm()
    .getFields()
    .map((field) => {
      const tooltip = field.acroField.dict.lookup(PDFName.of('TU'));
      const widget = field.acroField.getWidgets()[0];
      const pageRef = widget?.P();
      const page =
        (pageRef && pagesByRef.get(pageRef)) ?? (widget && pagesByAnnotation.get(widget.dict));
      const base = {
        name: field.getName(),
        required: field.isRequired(),
        ...((tooltip instanceof PDFString || tooltip instanceof PDFHexString) && {
          label: tooltip.decodeText(),
        }),
        ...(page !== undefined && { page }),
      };
      if (field instanceof PDFTextField) {
        // getText() throws for rich-text-only fields. /V is the optional plain value.
        const value = field.acroField.getValue()?.decodeText();
        const maxLength = field.getMaxLength();
        return {
          ...base,
          type: 'text',
          ...(value !== undefined && { value }),
          ...(maxLength !== undefined && { maxLength }),
        };
      }
      if (field instanceof PDFCheckBox) {
        const onValue = field.acroField.getOnValue()?.decodeText();
        return {
          ...base,
          type: 'checkbox',
          value: field.isChecked(),
          ...(onValue !== undefined && { onValue }),
        };
      }
      if (field instanceof PDFDropdown)
        return {
          ...base,
          type: 'dropdown',
          options: field.getOptions(),
          value: field.getSelected(),
        };
      if (field instanceof PDFOptionList)
        return {
          ...base,
          type: 'optionList',
          options: field.getOptions(),
          value: field.getSelected(),
        };
      if (field instanceof PDFRadioGroup) {
        const value = field.getSelected();
        return {
          ...base,
          type: 'radioGroup',
          options: field.getOptions(),
          ...(value !== undefined && { value }),
        };
      }
      if (field instanceof PDFSignature) return { ...base, type: 'signature' };
      if (field instanceof PDFButton) return { ...base, type: 'button' };
      throw new Error(`Unsupported AcroForm field class: ${field.constructor.name}`);
    });
}
