#!/usr/bin/env node
/**
 * @fileoverview docgen-mcp-server MCP server entry point. Renders structured agent
 * content (HTML/markdown/template, tabular rows, or a fillable PDF + field map) into
 * downloadable binary documents (PDF, xlsx), stores them tenant-scoped with a TTL,
 * and hands back a delivery envelope. Wires the render + storage services and
 * registers the document tool/resource surface.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { documentResource } from './mcp-server/resources/definitions/document.resource.js';
import { exportSpreadsheetTool } from './mcp-server/tools/definitions/export-spreadsheet.tool.js';
import { fillFormTool } from './mcp-server/tools/definitions/fill-form.tool.js';
import { getDocumentTool } from './mcp-server/tools/definitions/get-document.tool.js';
import { renderPdfTool } from './mcp-server/tools/definitions/render-pdf.tool.js';
import { initDocumentStore } from './services/document/document-store.js';
import { initRenderService } from './services/document/render-service.js';

await createApp({
  name: 'docgen-mcp-server',
  title: 'docgen-mcp-server',
  tools: [renderPdfTool, exportSpreadsheetTool, fillFormTool, getDocumentTool],
  resources: [documentResource],
  instructions:
    'Render structured content into downloadable documents: docgen_render_pdf (HTML/markdown/template → PDF), docgen_export_spreadsheet (named row sheets → xlsx), docgen_fill_form (fill an AcroForm PDF). Each returns a documentId; re-fetch within the TTL via docgen_get_document or the docgen://document/{id} resource. Small documents are returned inline as base64; otherwise fetch the bytes via the resource.',
  setup() {
    // Fail fast on malformed DOCGEN_* config (or an unimplemented engine) at startup.
    getServerConfig();
    initRenderService();
    initDocumentStore();
  },
});
