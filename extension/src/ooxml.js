// ===== OOXML text extraction & rewriting ====================================
// DOCX/XLSX/PPTX store their text as XML inside a ZIP. This module reads the
// user-visible text out of the text-bearing parts and writes redacted text back,
// so an Office file with PII can be CLEANED and sent rather than refused.
//
// THE CRITICAL DETAIL — Word splits words across runs. An address is routinely
// stored as <w:t>dana@</w:t><w:t>corp.example</w:t> because of spell-check state,
// formatting or revision ids. Scanning runs individually finds nothing, exactly
// like PII split across SSE chunks. So text is concatenated PER PARAGRAPH before
// it is scanned, and only paragraphs whose text actually changed are rewritten
// (an untouched paragraph keeps its original runs and formatting byte for byte).
//
// Paragraph granularity is the deliberate trade-off. Redaction happens on the
// joined paragraph text, so a modified paragraph collapses into its first run —
// its internal formatting (a bold word mid-sentence) is lost. Only paragraphs
// that CONTAINED PII are affected, and a mangled character run is a far smaller
// cost than either leaking the value or refusing the file.

/** Parts that hold user-visible text. Everything else (rels, theme, docProps)
 *  is left untouched — rewriting it risks corrupting the document for no gain. */
export const TEXT_PART_RE =
  /^(word\/(document|footnotes|endnotes|comments|header\d*|footer\d*)\.xml|xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml|ppt\/(slides|notesSlides)\/[a-z]+\d+\.xml)$/i;

/** Zip-based Office formats. The legacy binary .doc/.xls/.ppt are NOT included. */
export const OOXML_EXTENSIONS = new Set(["docx", "xlsx", "pptx", "docm", "xlsm", "pptm"]);

export function isOoxmlName(name) {
  const ext = String(name || "").split(".").pop().toLowerCase();
  return OOXML_EXTENSIONS.has(ext);
}

// Paragraph containers per format, and the text element inside them.
// `<w:p>` (Word), `<si>` (Excel shared strings), `<a:p>` (PowerPoint / shapes).
const PARA_RE = /<(w:p|a:p|si|c)(\s[^>]*)?>([\s\S]*?)<\/\1>|<(w:p|a:p)(\s[^>]*)?\/>/g;
const TEXT_RE = /<((?:w|a):t|t)(\s[^>]*)?>([\s\S]*?)<\/\1>/g;

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&"); // last, so "&amp;lt;" does not become "<"
}

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Paragraphs of a text-bearing part, in document order.
 *
 * @returns {Array<{text: string, nodes: Array<{start: number, end: number}>}>}
 *   `nodes` are the character ranges of each text element's CONTENT within the
 *   part, which is what `rebuildPart` rewrites.
 */
export function extractParagraphs(xml) {
  const paragraphs = [];
  PARA_RE.lastIndex = 0;
  let m;
  while ((m = PARA_RE.exec(xml)) !== null) {
    const inner = m[3];
    if (!inner) continue; // self-closing / empty paragraph
    const base = m.index + (m[0].length - inner.length - (m[1] ? m[1].length + 3 : 0));
    const nodes = [];
    let text = "";
    TEXT_RE.lastIndex = 0;
    let t;
    while ((t = TEXT_RE.exec(inner)) !== null) {
      const contentStart = base + t.index + t[0].indexOf(">", t[1].length) + 1;
      const raw = t[3];
      nodes.push({ start: contentStart, end: contentStart + raw.length });
      text += unescapeXml(raw);
    }
    if (nodes.length === 0) continue;
    paragraphs.push({ text, nodes });
  }
  return paragraphs;
}

/**
 * Write redacted paragraph text back into the part.
 *
 * @param {string} xml           the original part
 * @param {ReturnType<typeof extractParagraphs>} paragraphs
 * @param {string[]} redacted    one entry per paragraph, same order
 * @returns {string}
 *
 * Throws when the counts disagree: a misaligned rewrite would scatter one
 * paragraph's text into another's runs, so the caller must fail closed instead.
 */
export function rebuildPart(xml, paragraphs, redacted) {
  if (!Array.isArray(redacted) || redacted.length !== paragraphs.length) {
    throw new Error(`paragraph count mismatch: ${paragraphs.length} in, ${(redacted || []).length} back`);
  }
  // Apply from the END so earlier offsets stay valid.
  let out = xml;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const para = paragraphs[i];
    if (redacted[i] === para.text) continue; // untouched: keep runs verbatim
    const escaped = escapeXml(redacted[i]);
    // All of the paragraph's text goes into its FIRST run; the rest are emptied.
    for (let n = para.nodes.length - 1; n >= 0; n--) {
      const node = para.nodes[n];
      const replacement = n === 0 ? escaped : "";
      out = out.slice(0, node.start) + replacement + out.slice(node.end);
    }
  }
  return out;
}

/** The text-bearing parts of an archive, in order. */
export function textParts(entries) {
  return (entries || []).filter((e) => TEXT_PART_RE.test(e.name));
}
