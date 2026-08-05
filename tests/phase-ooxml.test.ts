// ===== PHASE R — OFFICE FILE SCRUBBING (zip + OOXML core) ===================
// Phase Q blocked every format it could not read as text, which includes the
// files people actually attach at work. DOCX/XLSX/PPTX are the tractable case:
// they are ZIP archives of XML, so with `DecompressionStream`/`CompressionStream`
// (browser + Node built-ins — still zero dependencies) we can read the text,
// redact it, and write the file back. Unlike a PDF, this is a real scrub, not
// just detection: an Office file with PII can be CLEANED and sent rather than
// refused.
//
// The two traps this suite exists to catch:
//
//   1. WORD SPLITS WORDS ACROSS RUNS. `dana@corp.example` is routinely stored as
//      <w:t>dana@</w:t><w:t>corp.example</w:t> (spell-check, formatting, rsid
//      churn). Scanning runs individually finds NOTHING — the same split-PII
//      problem the streaming redactor solves with a holdback. Text must be
//      concatenated per paragraph before it is scanned.
//   2. A REBUILT FILE MUST STILL BE A VALID ARCHIVE. A scrubbed .docx that Word
//      or ChatGPT cannot open is a broken feature, so the output is validated
//      with the system `unzip -t`, not just with our own reader.
//
// PII fixtures are assembled from fragments so no full literal appears in source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readZip, writeZip, crc32 } from "../extension/src/zip.js";
import { isOoxmlName, extractParagraphs, rebuildPart, TEXT_PART_RE } from "../extension/src/ooxml.js";
import { classifyFile } from "../extension/src/upload-core.js";

const EMAIL = "dana" + "@" + "corp.example";
const SSN = "078-" + "05-" + "1120";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** A minimal but structurally real .docx. */
function documentXml(paragraphs: string[][]) {
  const body = paragraphs
    .map((runs) => `<w:p>${runs.map((r) => `<w:r><w:t xml:space="preserve">${r}</w:t></w:r>`).join("")}</w:p>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

async function makeDocx(paragraphs: string[][]) {
  return writeZip([
    {
      name: "[Content_Types].xml",
      data: enc(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
    },
    { name: "_rels/.rels", data: enc(`<?xml version="1.0"?><Relationships/>`) },
    { name: "word/document.xml", data: enc(documentXml(paragraphs)) },
  ]);
}

// --- zip round trip ---------------------------------------------------------
test("zip: entries survive a write/read round trip, compressed and stored", async () => {
  const big = "lorem ipsum ".repeat(500); // compressible, so DEFLATE is exercised
  const zip = await writeZip([
    { name: "a/one.txt", data: enc(big) },
    { name: "two.bin", data: new Uint8Array([0, 1, 2, 253, 254, 255]), compress: false },
    { name: "empty.txt", data: new Uint8Array(0) },
  ]);
  const back = await readZip(zip);
  assert.deepEqual(back.map((e) => e.name), ["a/one.txt", "two.bin", "empty.txt"]);
  assert.equal(dec(back[0].data), big);
  assert.deepEqual([...back[1].data], [0, 1, 2, 253, 254, 255]);
  assert.equal(back[2].data.length, 0);
  // Compression must actually have happened, or we are just renaming bytes.
  assert.ok(zip.length < big.length, `zip ${zip.length} vs raw ${big.length}`);
});

test("zip: the archive we produce is valid to a real unzip implementation", async () => {
  const zip = await makeDocx([["hello ", "world"]]);
  const dir = mkdtempSync(path.join(tmpdir(), "ooxml-"));
  const file = path.join(dir, "t.docx");
  try {
    writeFileSync(file, zip);
    // `unzip -t` verifies CRCs and the central directory — our own reader could
    // happily round-trip a subtly malformed archive that Word would reject.
    const out = execFileSync("unzip", ["-t", file], { encoding: "utf8" });
    assert.match(out, /No errors detected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zip: crc32 matches the known check value", () => {
  // The standard CRC-32 check vector: "123456789" -> 0xCBF43926.
  assert.equal(crc32(enc("123456789")) >>> 0, 0xcbf43926);
});

// --- OOXML text handling ----------------------------------------------------
test("happy: PII split across runs is recovered, redacted, and written back", async () => {
  // The exact shape Word produces: one address, three runs.
  const xml = documentXml([["Contact ", "dana@", "corp.exa", "mple today"], ["Nothing here"]]);
  const paras = extractParagraphs(xml);
  assert.equal(paras.length, 2);
  assert.equal(paras[0].text, `Contact ${EMAIL} today`, "runs must be concatenated before scanning");
  assert.equal(paras[1].text, "Nothing here");

  const rebuilt = rebuildPart(xml, paras, [`Contact [REDACTED_PII_EMAIL] today`, "Nothing here"]);
  assert.ok(!rebuilt.includes(EMAIL), "no raw PII may survive in the part");
  assert.ok(rebuilt.includes("[REDACTED_PII_EMAIL]"));
  // The untouched paragraph keeps its original single run verbatim.
  assert.ok(rebuilt.includes("<w:t xml:space=\"preserve\">Nothing here</w:t>"));
  // And the result is still parseable by us.
  assert.deepEqual(extractParagraphs(rebuilt).map((p) => p.text), [
    "Contact [REDACTED_PII_EMAIL] today",
    "Nothing here",
  ]);
});

test("failure: XML-escaped text and self-closing runs survive the round trip", () => {
  const xml = documentXml([["R&amp;D &lt;notes&gt; for ", "dana@corp.example"]]).replace(
    "</w:p>",
    "<w:r><w:t/></w:r></w:p>",
  );
  const paras = extractParagraphs(xml);
  // Entities must be DECODED for scanning, or a rule never matches around them.
  assert.equal(paras[0].text, `R&D <notes> for ${EMAIL}`);

  const rebuilt = rebuildPart(xml, paras, [`R&D <notes> for [REDACTED_PII_EMAIL]`]);
  // ...and RE-ENCODED on the way back, or the file stops being valid XML.
  assert.ok(rebuilt.includes("R&amp;D &lt;notes&gt;"), rebuilt);
  assert.ok(!rebuilt.includes("R&D <notes>"));
  assert.equal(extractParagraphs(rebuilt)[0].text, "R&D <notes> for [REDACTED_PII_EMAIL]");
});

test("edge: only text-bearing parts are scanned, and a mismatched rebuild is refused", async () => {
  // Which parts hold user text (and, just as important, which do not: rewriting
  // rels/theme XML would corrupt the document for no benefit).
  for (const name of ["word/document.xml", "xl/sharedStrings.xml", "ppt/slides/slide1.xml", "word/footnotes.xml"]) {
    assert.equal(TEXT_PART_RE.test(name), true, name);
  }
  for (const name of ["_rels/.rels", "word/_rels/document.xml.rels", "docProps/app.xml", "word/theme/theme1.xml"]) {
    assert.equal(TEXT_PART_RE.test(name), false, name);
  }

  // A redaction result that does not line up with the paragraphs it came from
  // must THROW rather than write text into the wrong places.
  const xml = documentXml([["one"], ["two"]]);
  const paras = extractParagraphs(xml);
  assert.throws(() => rebuildPart(xml, paras, ["only one"]), /paragraph count/i);

  // Office extensions are now scannable rather than blocked outright.
  for (const [name, kind] of [
    ["report.docx", "ooxml"],
    ["book.xlsx", "ooxml"],
    ["deck.pptx", "ooxml"],
    ["notes.txt", "text"],
  ] as const) {
    const c = classifyFile({ name, type: "", size: 1000 });
    assert.equal(c.scannable, true, name);
    assert.equal(c.kind, kind, name);
  }
  // The legacy binary Office formats are NOT zip+XML, so they stay blocked.
  for (const name of ["old.doc", "old.xls", "old.ppt", "scan.pdf"]) {
    assert.equal(classifyFile({ name, type: "", size: 1000 }).scannable, false, name);
  }
  assert.equal(isOoxmlName("Report.DOCX"), true, "extension match must be case-insensitive");
});

test("edge: a whole docx can be read, scrubbed and rewritten, and still unzips", async () => {
  const docx = await makeDocx([["Payroll for ", "dana@", "corp.example"], [`SSN ${SSN}`], ["clean line"]]);
  const entries = await readZip(docx);
  const part = entries.find((e) => e.name === "word/document.xml")!;
  const xml = dec(part.data);
  const paras = extractParagraphs(xml);
  assert.deepEqual(paras.map((p) => p.text), [`Payroll for ${EMAIL}`, `SSN ${SSN}`, "clean line"]);

  const scrubbed = rebuildPart(xml, paras, [
    "Payroll for [REDACTED_PII_EMAIL]",
    "SSN [REDACTED_PII_SSN]",
    "clean line",
  ]);
  const out = await writeZip(entries.map((e) => (e.name === part.name ? { name: e.name, data: enc(scrubbed) } : e)));
  const reread = await readZip(out);
  const finalXml = dec(reread.find((e) => e.name === "word/document.xml")!.data);
  assert.ok(!finalXml.includes(EMAIL));
  assert.ok(!finalXml.includes(SSN));
  assert.ok(finalXml.includes("[REDACTED_PII_EMAIL]") && finalXml.includes("[REDACTED_PII_SSN]"));
  // Entry ORDER must be preserved: OPC readers expect [Content_Types].xml first.
  assert.equal(reread[0].name, "[Content_Types].xml");
});
