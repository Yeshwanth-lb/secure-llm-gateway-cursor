#!/usr/bin/env node
// Build a .docx for testing the Phase R Office scrub against a live surface.
// Sibling of gen-pii-sample.mjs, for attachments instead of typed prompts.
//
// The PII is SPLIT ACROSS RUNS exactly as Word stores it (spell-check state and
// revision ids routinely fragment a word), because that is the case a naive
// per-run scan misses. A fixture with each value in one run would pass even if
// the paragraph concatenation were broken.
//
// Values are assembled from fragments so no complete literal appears in source.

import { writeFileSync } from "node:fs";
import { writeZip } from "../extension/src/zip.js";

const enc = (s) => new TextEncoder().encode(s);

const PARAGRAPHS = [
  ["Client contact: ", "dana@", "corp.exa", "mple"],
  ["SSN on file: 078-", "05-", "1120"],
  ["Card 4111 ", "1111 1111 ", "1111 for the retainer."],
  ["This paragraph has no sensitive data and must come back untouched."],
];

const body = PARAGRAPHS.map(
  (runs) => `<w:p>${runs.map((r) => `<w:r><w:t xml:space="preserve">${r}</w:t></w:r>`).join("")}</w:p>`,
).join("");

const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const out = process.argv[2] || "upload-office-test.docx";
const zip = await writeZip([
  { name: "[Content_Types].xml", data: enc(contentTypes) },
  { name: "_rels/.rels", data: enc(rels) },
  { name: "word/document.xml", data: enc(document) },
]);
writeFileSync(out, zip);
console.log(`wrote ${out} (${zip.length} bytes, ${PARAGRAPHS.length} paragraphs, PII split across runs)`);
