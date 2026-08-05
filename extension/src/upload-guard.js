// ===== UPLOAD GUARD — DOM glue (attach-time kill & re-fire) =================
// Same shape as the composer interceptor, for a different entry point: swallow the
// event that hands the page a File, decide with the gateway, then re-fire with a
// redacted File (or refuse). Decisions live in upload-core.js (pure, unit-tested);
// this file is only the DOM plumbing.
//
// WHY ATTACH TIME AND NOT SUBMIT. Probed live on chatgpt.com 2026-07-30: the
// bytes are PUT ~259ms after the `change` event and ~19 SECONDS before the
// message is sent. Guarding the submit would be far too late — and it also means
// attaching a file and then REMOVING it before sending already leaked it.
//
// WHY KILLING THE EVENT IS SAFE HERE. We cannot pause a DOM event across an async
// gateway call, so the original is fully killed (`stopImmediatePropagation` in the
// CAPTURE phase, before the page's delegated React handler) and an independent
// synthetic one is fired afterwards. The loop guard is per-target/per-event
// (SYNTHETIC), mirroring interceptor-core.js.
//
// The input is also CLEARED immediately, not just left unread: ChatGPT's uploader
// reads `input.files`, so an input still holding the raw File could be picked up
// by any later poll or re-render before our async decision lands.

import { classifyFile, decideUpload } from "./upload-core.js";
import { readZip, writeZip } from "./zip.js";
import { extractParagraphs, rebuildPart, textParts } from "./ooxml.js";

// Paragraphs are joined with NUL for the single gateway round trip. It cannot
// occur in XML text (it is not a legal XML character), so the split back is
// unambiguous — and because no redaction rule matches across it, PII is never
// "found" spanning two unrelated paragraphs.
const SEP = "\u0000";

/** Marks our own synthetic events/targets so we never re-process them. */
const SYNTHETIC = "__geminiRedactUploadSynthetic";

const list = (fileList) => Array.from(fileList || []);

/** A File carrying the redacted text, keeping name/type so the page is none the wiser. */
function replacementFile(file, text) {
  return new File([text], file.name, {
    type: file.type || "text/plain",
    lastModified: file.lastModified || Date.now(),
  });
}

/**
 * Install the guard. No-op unless this surface has been PROBED and enabled
 * (`adapter.uploadGuard`) — arming it on an unprobed surface could break
 * attachments for a gap that is merely documented.
 *
 * @param {any} win
 * @param {{
 *   adapter: object,
 *   redact: (text: string) => Promise<{ok: boolean, redacted?: string, piiDetected?: boolean}>,
 *   notify: (reason: string, detail?: string) => void,
 *   policy?: "block" | "warn",
 *   audit?: (turn: {prompt: string, response: string, unchecked: boolean}) => void,
 *   debug?: boolean,
 * }} opts
 * @returns {boolean} whether it installed
 */
export function installUploadGuard(win, opts = {}) {
  const { adapter, redact, notify, audit, debug } = opts;
  // "block" (default) refuses anything unreadable; "warn" uploads it and files an
  // `unchecked` audit row instead. Safe default, escape hatch available.
  const policy = opts.policy === "warn" ? "warn" : "block";
  if (!adapter || !adapter.uploadGuard) return false;
  if (!win || !win.document || typeof win.File !== "function" || typeof win.DataTransfer !== "function") return false;

  const trace = (...a) => {
    if (debug) console.info("[gemini-redact][upload]", ...a);
  };

  /**
   * DOCX/XLSX/PPTX: unzip, scan the text of every text-bearing part, and write a
   * cleaned archive back. Unlike a PDF this is a real scrub, so a work document
   * containing PII can be sent cleaned rather than refused.
   *
   * Every failure returns a BLOCK: a corrupt/unsupported archive, an unreachable
   * gateway, or a redaction result that does not line up paragraph-for-paragraph
   * (writing misaligned text into a document would be worse than refusing it).
   */
  async function scrubOoxml(file) {
    let entries;
    try {
      entries = await readZip(await file.arrayBuffer());
    } catch (e) {
      trace("zip read failed", file.name, (e && e.message) || e);
      return { action: "block", reason: "upload-unreadable", detail: "not a readable Office file" };
    }

    const parts = [];
    for (const entry of textParts(entries)) {
      const xml = new TextDecoder().decode(entry.data);
      parts.push({ entry, xml, paragraphs: extractParagraphs(xml) });
    }
    const texts = parts.flatMap((p) => p.paragraphs.map((x) => x.text));
    // A document with no readable text (an all-images deck) has nothing to leak
    // through this path, so it is not a block.
    if (texts.length === 0) return { action: "allow", reason: "no-text" };

    const joined = texts.join(SEP);
    const redaction = await redact(joined);
    if (!redaction || redaction.ok !== true || typeof redaction.redacted !== "string") {
      return { action: "block", reason: "gateway-unreachable" };
    }
    if (redaction.redacted === joined && redaction.piiDetected !== true) {
      return { action: "allow", reason: "no-pii" };
    }

    const back = redaction.redacted.split(SEP);
    if (back.length !== texts.length) {
      return { action: "block", reason: "upload-unreadable", detail: "could not map redacted text back" };
    }

    let at = 0;
    const rewritten = new Map();
    try {
      for (const part of parts) {
        const slice = back.slice(at, at + part.paragraphs.length);
        at += part.paragraphs.length;
        const xml = rebuildPart(part.xml, part.paragraphs, slice);
        if (xml !== part.xml) rewritten.set(part.entry.name, new TextEncoder().encode(xml));
      }
    } catch (e) {
      return { action: "block", reason: "upload-unreadable", detail: (e && e.message) || String(e) };
    }

    const bytes = await writeZip(
      entries.map((e) => (rewritten.has(e.name) ? { name: e.name, data: rewritten.get(e.name) } : e)),
    );
    const cleaned = new File([bytes], file.name, {
      type: file.type || "application/octet-stream",
      lastModified: file.lastModified || Date.now(),
    });
    return { action: "replace", reason: "pii-redacted", file: cleaned };
  }

  /** Read + redact + decide, one file at a time (bodies are small; order is stable). */
  async function decideAll(files) {
    const out = [];
    for (const file of files) {
      const cls = classifyFile(file);
      let decision;
      if (cls.kind === "ooxml") {
        decision = await scrubOoxml(file);
      } else {
        let text = null;
        let redaction = null;
        if (cls.scannable) {
          try {
            text = await file.text();
          } catch {
            text = null; // -> upload-unreadable -> block
          }
          if (typeof text === "string") redaction = await redact(text);
        }
        decision = decideUpload({ file, text, redaction });
      }
      trace(file.name, cls.reason, "->", decision.action, decision.reason);
      out.push({ file, decision });
    }
    return out;
  }

  /**
   * Turn decisions into the FileList to re-fire, or null when anything is
   * blocked. All-or-nothing on purpose: silently dropping one file from a
   * multi-file attach while sending the rest is the kind of partial success a
   * user would not notice.
   */
  function settle(results) {
    const blocked = [];
    for (const r of results) {
      if (r.decision.action !== "block") continue;
      // POLICY ESCAPE HATCH. With `uploadPolicy: "warn"`, a file we simply cannot
      // READ (a scan, an image, an encrypted document) is allowed through and
      // AUDITED instead of refused, for people who must attach real work files.
      // Scoped to `upload-unscannable` on purpose: a gateway failure or a
      // rebuild that would not line up still blocks, because those are OUR
      // failure to verify a file we can read, not a limit of the format.
      if (policy === "warn" && r.decision.reason === "upload-unscannable") {
        auditUnscanned(r.file, r.decision.detail);
        r.decision = { action: "allow", reason: "unscanned-allowed" };
        continue;
      }
      blocked.push(r);
    }
    if (blocked.length) {
      const first = blocked[0].decision;
      notify(uploadReason(first), `${blocked[0].file.name}: ${first.detail || first.reason}`);
      return null;
    }
    const dt = new win.DataTransfer();
    for (const r of results) {
      // An Office scrub returns a whole rebuilt File; a text scrub returns text.
      const replacement = r.decision.file || (r.decision.action === "replace" ? replacementFile(r.file, r.decision.text) : null);
      dt.items.add(replacement || r.file);
    }
    return dt;
  }

  /**
   * Record that a file left the machine WITHOUT being scanned. Reuses the
   * `unchecked` flag built for Cursor's unblockable paths, so the Inspector shows
   * the existing pill. Metadata only — name and size, never content, which we
   * could not read anyway.
   */
  function auditUnscanned(file, detail) {
    const kb = Math.max(1, Math.round((file.size || 0) / 1024));
    console.warn("[gemini-redact][upload] uploaded WITHOUT a PII scan:", file.name, `${kb} KB`, detail || "");
    if (typeof audit !== "function") return;
    audit({
      prompt: `(attached file uploaded without a PII scan: ${file.name}, ${kb} KB — ${detail || "unreadable format"})`,
      response: "",
      unchecked: true,
    });
  }

  /** Map a core reason to the reason string notifyBlocked/UI understands. */
  function uploadReason(decision) {
    return decision.reason === "gateway-unreachable" ? "gateway-unreachable" : "upload-blocked";
  }

  // --- file picker ----------------------------------------------------------
  win.document.addEventListener(
    "change",
    (event) => {
      const el = event.target;
      if (!el || el.tagName !== "INPUT" || String(el.type).toLowerCase() !== "file") return;
      if (el[SYNTHETIC]) {
        el[SYNTHETIC] = false; // our own re-fire: let it through exactly once
        return;
      }
      const files = list(el.files);
      if (files.length === 0) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      // Detach the raw files from the DOM before yielding to the async decision.
      try {
        el.value = "";
      } catch {
        /* some inputs refuse; the kill above is the load-bearing part */
      }

      decideAll(files).then((results) => {
        const dt = settle(results);
        if (!dt) return; // blocked — input stays empty
        try {
          el[SYNTHETIC] = true;
          el.files = dt.files;
          el.dispatchEvent(new win.Event("change", { bubbles: true }));
        } catch (e) {
          el[SYNTHETIC] = false;
          notify("upload-blocked", `could not re-attach ${files.length} file(s): ${(e && e.message) || e}`);
        }
      });
    },
    true,
  );

  // --- drag & drop ----------------------------------------------------------
  win.document.addEventListener(
    "drop",
    (event) => {
      if (event[SYNTHETIC]) return;
      const files = list(event.dataTransfer && event.dataTransfer.files);
      if (files.length === 0) return;
      const target = event.target || win.document.body;

      event.preventDefault();
      event.stopImmediatePropagation();

      decideAll(files).then((results) => {
        const dt = settle(results);
        if (!dt) return;
        try {
          const synthetic = new win.DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
          synthetic[SYNTHETIC] = true;
          target.dispatchEvent(synthetic);
        } catch (e) {
          notify("upload-blocked", `could not re-drop ${files.length} file(s): ${(e && e.message) || e}`);
        }
      });
    },
    true,
  );

  // --- paste ---------------------------------------------------------------
  // A pasted screenshot is the common case, and an image is unscannable, so it
  // ends in a block by policy. Re-firing a synthetic paste is best-effort:
  // `ClipboardEvent` with a constructed `clipboardData` is not supported
  // everywhere, so a failure is reported as a block (use the picker) rather than
  // quietly letting the original through.
  win.document.addEventListener(
    "paste",
    (event) => {
      if (event[SYNTHETIC]) return;
      const files = list(event.clipboardData && event.clipboardData.files);
      if (files.length === 0) return; // plain text paste — the composer path handles it
      const target = event.target || win.document.body;

      event.preventDefault();
      event.stopImmediatePropagation();

      decideAll(files).then((results) => {
        const dt = settle(results);
        if (!dt) return;
        try {
          const synthetic = new win.ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
          if (!synthetic.clipboardData || list(synthetic.clipboardData.files).length !== dt.files.length) {
            throw new Error("clipboardData not carried by the synthetic event");
          }
          synthetic[SYNTHETIC] = true;
          target.dispatchEvent(synthetic);
        } catch {
          notify("upload-blocked", "pasted file could not be re-attached safely — attach it with the + button instead");
        }
      });
    },
    true,
  );

  trace("installed for", adapter.id);
  return true;
}
