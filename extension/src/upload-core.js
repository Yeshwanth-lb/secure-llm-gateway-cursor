// ===== UPLOAD GUARD — PURE DECISION CORE ====================================
// Attaching a file bypassed everything: the composer interceptor never sees it,
// and the upload does not touch the conversation endpoint the tripwire inspects.
// Probed live on chatgpt.com 2026-07-30 (extension/CHATGPT_COVERAGE.md §6):
//
//   input.change   pii-sample.txt  652 B  text/plain
//   xhr PUT  https://<region>.oaiusercontent.com/files/<id>/raw   body: File
//   fetch POST /backend-api/f/conversation                        19s LATER
//
// The bytes leave at ATTACH time, long before the message is sent — so the guard
// runs on change/drop/paste, never at submit. (It also means attaching a file and
// removing it before sending has already leaked it.)
//
// THE CEILING, chosen deliberately: text-like files can be read and scrubbed.
// PDF/DOCX/XLSX/images cannot be parsed without adding libraries, and zero
// runtime dependencies is a hard project constraint — so they are BLOCKED rather
// than uploaded unscanned. Fail-closed, like every other path we cannot verify.
//
// This module is PURE (no DOM, no network) so the decisions above are unit-tested
// headlessly in tests/phase-upload.test.ts. The DOM kill-and-re-fire lives in
// upload-guard.js; the wire-level backstop in tripwire.js.

/** Above this, a file is treated as unscannable rather than partially scanned. */
export const MAX_SCAN_BYTES = 2 * 1024 * 1024;
/** Office files are compressed, so the same text budget allows a bigger file. */
export const MAX_OOXML_BYTES = 8 * 1024 * 1024;

// Extensions we can read as text and therefore redact. SVG is included on
// purpose: it is XML, and replacing a PII substring leaves it valid.
const TEXT_EXTENSIONS = new Set([
  "txt", "text", "md", "markdown", "rst", "adoc", "tex", "bib",
  "csv", "tsv", "json", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties",
  "log", "xml", "svg", "html", "htm", "css", "scss", "less",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "vue", "svelte",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cc", "cs", "php", "pl", "lua", "dart", "scala", "r", "jl",
  "sh", "bash", "zsh", "fish", "sql", "graphql", "gql", "proto", "tf", "patch", "diff", "srt", "vtt",
  "dockerfile", "makefile", "gitignore", "gitattributes", "editorconfig",
]);

// Formats we cannot parse without a dependency. An extension in this set wins
// over ANY declared MIME type (see classifyFile). DOCX/XLSX/PPTX are NOT here —
// they are zip+XML and are handled by ooxml.js; the legacy binary .doc/.xls/.ppt
// are a different format entirely and stay blocked.
const BINARY_EXTENSIONS = new Set([
  "pdf", "doc", "xls", "ppt", "odt", "ods", "odp", "rtf", "pages", "numbers", "key", "epub",
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar",
  "png", "jpg", "jpeg", "gif", "bmp", "tiff", "tif", "webp", "ico", "heic", "heif", "avif", "psd", "ai", "eps",
  "mp3", "wav", "flac", "aac", "ogg", "oga", "m4a", "mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v",
  "exe", "dll", "so", "dylib", "bin", "dmg", "iso", "pkg", "deb", "rpm", "jar", "war", "class", "pyc", "wasm",
  "db", "sqlite", "sqlite3", "parquet", "ttf", "otf", "woff", "woff2", "eot",
]);

import { OOXML_EXTENSIONS } from "./ooxml.js";

// Text MIME types that don't start with "text/".
const TEXT_MIMES = new Set([
  "application/json", "application/ld+json", "application/xml", "application/xhtml+xml",
  "application/javascript", "application/ecmascript", "application/x-sh",
  "application/x-yaml", "application/yaml", "application/toml", "application/sql",
  "image/svg+xml",
]);

/** Lowercase extension of `name`, or "" when it has none. */
function extOf(name) {
  const base = String(name || "").split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  // A dotfile like ".gitignore" has no extension but its NAME identifies it.
  if (dot <= 0) return base.startsWith(".") ? base.slice(1).toLowerCase() : "";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Can this file be read and therefore redacted?
 * `{ scannable, kind, reason }` — `kind` selects the reader (`"text"` reads the
 * bytes directly, `"ooxml"` goes through zip + XML). `reason` is for the log/UI,
 * never a decision input.
 */
export function classifyFile(fileLike) {
  const f = fileLike || {};
  const type = String(f.type || "").toLowerCase().split(";")[0].trim();
  const size = Number.isFinite(Number(f.size)) ? Number(f.size) : 0;
  const ext = extOf(f.name);

  // A binary EXTENSION beats a text MIME type. MIME is caller-supplied metadata,
  // so trusting it would let `payroll.pdf` declared as `text/plain` reach a text
  // scan, "pass" clean, and upload raw. Extension-first is the fail-closed order.
  if (ext && BINARY_EXTENSIONS.has(ext)) return { scannable: false, kind: "none", reason: "binary-extension" };

  // Office files are ZIP archives of XML: readable and rewritable with built-ins.
  // They get a larger budget than plain text because the payload is compressed.
  if (OOXML_EXTENSIONS.has(ext)) {
    if (size > MAX_OOXML_BYTES) return { scannable: false, kind: "none", reason: "too-large" };
    return { scannable: true, kind: "ooxml", reason: "ooxml" };
  }

  const textByExt = !!ext && TEXT_EXTENSIONS.has(ext);
  const textByMime = type.startsWith("text/") || TEXT_MIMES.has(type) || type.endsWith("+json") || type.endsWith("+xml");
  if (!textByExt && !textByMime) {
    return { scannable: false, kind: "none", reason: type || ext ? "unsupported-type" : "unknown-type" };
  }

  if (size > MAX_SCAN_BYTES) return { scannable: false, kind: "none", reason: "too-large" };
  return { scannable: true, kind: "text", reason: "text" };
}

/**
 * What to do with an attached file.
 *
 * @param {{file: object, text: ?string, redaction: ?object}} input
 *   `text` is the file read as text (null if unreadable/not attempted);
 *   `redaction` is the gateway result `{ ok, redacted, piiDetected }` (null if
 *   not attempted).
 * @returns {{action: "allow"|"replace"|"block", reason: string, detail?: string, text?: string}}
 *
 * Every uncertain path returns "block": an unparseable format, an unreadable
 * file, an unreachable gateway, or a gateway answer without usable text. Only a
 * positive, verified result allows bytes out.
 */
export function decideUpload({ file, text, redaction } = {}) {
  const c = classifyFile(file);
  if (!c.scannable) return { action: "block", reason: "upload-unscannable", detail: c.reason };

  // An empty string is a legitimate read (empty file); null/undefined is not.
  if (typeof text !== "string") return { action: "block", reason: "upload-unreadable" };

  if (!redaction || redaction.ok !== true || typeof redaction.redacted !== "string") {
    return { action: "block", reason: "gateway-unreachable" };
  }

  const redacted = redaction.redacted;
  // Trust EITHER signal: a changed body or an explicit piiDetected. Requiring
  // both would let a rule that tokenises to the same length slip through.
  if (redacted !== text || redaction.piiDetected === true) {
    return { action: "replace", reason: "pii-redacted", text: redacted };
  }
  // Clean: upload the ORIGINAL file untouched rather than a re-wrapped copy.
  return { action: "allow", reason: "no-pii" };
}

/**
 * Does `url` look like a file-UPLOAD request for this surface?
 *
 * Endpoints are `{ host, path }` (both optional, AND-ed) or a plain substring.
 * The observed ChatGPT host is REGION-SPECIFIC
 * (`sdmntprcentralindia.oaiusercontent.com`), so the host is matched as a domain
 * SUFFIX and never hard-coded — a user in another region must be covered too.
 */
export function isUploadUrl(url, endpoints = []) {
  let u;
  try {
    u = new URL(String(url), typeof location !== "undefined" ? location.href : "https://invalid.invalid");
  } catch {
    return false;
  }
  return (endpoints || []).some((e) => {
    if (!e) return false;
    if (typeof e === "string") return (u.origin + u.pathname).includes(e);
    const hostOk = !e.host || u.hostname === e.host || u.hostname.endsWith("." + e.host);
    const pathOk = !e.path || u.pathname.includes(e.path);
    return hostOk && pathOk;
  });
}

/** Is `body` a Blob/File (the shape ChatGPT PUTs), rather than a string? */
export function isBinaryBody(body) {
  return typeof Blob !== "undefined" && body instanceof Blob;
}

/**
 * The file-bearing parts of an outgoing request body, for the wire-level backstop
 * to read. Returns Blobs (never text) so the async read stays with the caller.
 *
 * Two body shapes are in play, one per probed surface:
 *   - a raw Blob/File — ChatGPT PUTs the file as the whole body;
 *   - multipart FormData — Grok POSTs `{ field:"file", File }` to
 *     `/http/upload-file-v2/direct` (probed live 2026-07-31).
 *
 * ALL file parts are returned, not the first: PII in the second file of a
 * multi-file attach would otherwise sail past the backstop.
 *
 * Anything else — a string, JSON, URLSearchParams, an unexpected shape — yields
 * `[]` rather than throwing. This runs inside the fetch/XHR wrapper on every
 * request, so a throw here would break uploads (or the whole page) instead of
 * guarding them.
 */
export function uploadBlobsOf(body) {
  if (isBinaryBody(body)) return [body];
  if (typeof FormData === "undefined" || !(body instanceof FormData)) return [];
  try {
    const out = [];
    for (const [, value] of body.entries()) {
      if (typeof Blob !== "undefined" && value instanceof Blob) out.push(value);
    }
    return out;
  } catch {
    return [];
  }
}
