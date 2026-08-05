// ===== FILE-UPLOAD FLOW PROBE (paste into the page's DevTools console) =======
// SURFACE-AGNOSTIC. Used for chatgpt.com (2026-07-30) and reusable as-is for
// grok.com, gemini.google.com or any future surface — nothing here is
// site-specific, so there is deliberately ONE copy rather than a per-site fork
// that would drift.
//
// It answers the four questions that decide whether a surface's uploads can be
// guarded at all, and how:
//
//   1. WHO issues the upload — page JavaScript (so our fetch/XHR wrapper, and
//      therefore the tripwire, can see and abort it) or something out of reach
//      (a service worker, sendBeacon, a native form POST)?
//   2. WHEN do the bytes leave — at ATTACH time or at SEND time? On ChatGPT they
//      left ~19s BEFORE the message was sent, which is why the guard hooks
//      change/drop/paste and NOT submit. Guarding submit would have been useless,
//      and it means attaching a file then removing it has already leaked it.
//   3. WHERE do they go — the host+path that becomes the adapter's
//      `uploadEndpoints`. ChatGPT's host is REGION-specific
//      (`sdmntprcentralindia.oaiusercontent.com`), so it must be matched as a
//      domain SUFFIX, never hard-coded.
//   4. WHAT SHAPE is the body — a raw File/Blob (what ChatGPT PUTs, which
//      `upload-core.isBinaryBody` and the tripwire backstop handle today), or
//      multipart FormData, or base64 inlined into a JSON string? The last two are
//      NOT handled by the current guard and would be real new work, so this is
//      the answer that most changes the estimate.
//
// Runs in the page you are already signed into, so no automated-browser login.
// READ-ONLY: it wraps fetch/XHR to record REQUEST METADATA and then calls the
// original. It never blocks, never retries, and never changes a body.
//
// PRIVACY: it deliberately records NO body content — only method, origin+path,
// the body's TYPE, its byte size, and for multipart the field/file names, sizes
// and MIME types. File CONTENT is never read, so nothing you attach can end up
// in a report you paste back. Use throwaway data anyway (`pii-sample.txt`).
//
// HOW TO USE
//   1. Open the tab you are signed into (chatgpt.com / grok.com / …), then
//      DevTools -> Console.
//      (Firefox blocks pasting into the console until you type: allow pasting)
//   2. Paste this whole file and press Enter.
//   3. Attach a small TEXT file (pii-sample.txt).
//   4. Send the message, then immediately run:  uploadProbe.mark("sent")
//      — that timestamp is what turns "bytes left at some point" into the
//      attach-vs-send answer of question 2.
//   5. Run:  uploadProbe.report()
//   6. Paste the printed report back. `uploadProbe.stop()` restores everything.
//
// Read `report().summary` first: it answers all four questions. `rows` is the
// raw timeline behind it, and `all()` is everything including GETs.

(() => {
  const seen = [];
  const t0 = Date.now();
  const origFetch = window.fetch;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);

  /** origin + pathname only — query strings can carry tokens. */
  const where = (u) => {
    try {
      const url = new URL(String(u), location.href);
      return url.origin + url.pathname;
    } catch {
      return String(u).slice(0, 120);
    }
  };

  /** Describe a request body by SHAPE only. Never returns content. */
  const shape = (body) => {
    if (body == null) return { kind: "none" };
    if (typeof body === "string") return { kind: "string", bytes: body.length };
    if (body instanceof Blob) return { kind: body instanceof File ? "File" : "Blob", bytes: body.size, mime: body.type };
    if (body instanceof ArrayBuffer) return { kind: "ArrayBuffer", bytes: body.byteLength };
    if (body instanceof URLSearchParams) return { kind: "URLSearchParams", bytes: String(body).length };
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const parts = [];
      for (const [k, v] of body.entries()) {
        parts.push(
          v instanceof File
            ? { field: k, kind: "File", name: v.name, bytes: v.size, mime: v.type }
            : { field: k, kind: "text", bytes: String(v).length },
        );
      }
      return { kind: "FormData", parts };
    }
    if (body && typeof body.getReader === "function") return { kind: "ReadableStream" };
    return { kind: typeof body };
  };

  const record = (via, method, url, body, extra) => {
    seen.push({
      ms: Date.now() - t0,
      via,
      method: String(method || "GET").toUpperCase(),
      url: where(url),
      body: shape(body),
      ...(extra || {}),
    });
  };

  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    const method = (init && init.method) || (input && input.method) || "GET";
    // A Request object's body is a stream we must not consume — report as such.
    record("fetch", method, url, init ? init.body : undefined, init && init.body === undefined && input && input.body ? { note: "body on Request object (stream)" } : undefined);
    return origFetch.apply(this, arguments);
  };

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__probe = { method, url };
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const p = this.__probe || {};
    record("xhr", p.method, p.url, body);
    return origSend.apply(this, arguments);
  };

  if (origBeacon) {
    navigator.sendBeacon = function (url, data) {
      record("sendBeacon", "POST", url, data);
      return origBeacon(url, data);
    };
  }

  // Note WHEN a file enters the page, so the requests that follow can be paired
  // with it. Name/size/type only — the file is never read.
  const noteFiles = (label, files) => {
    for (const f of files || []) record("file-selected", label, location.href, f, { fileName: f.name, mime: f.type });
  };
  const onChange = (e) => {
    const el = e.target;
    if (el && el.tagName === "INPUT" && el.type === "file") noteFiles("input.change", el.files);
  };
  const onDrop = (e) => noteFiles("drop", (e.dataTransfer || {}).files);
  const onPaste = (e) => noteFiles("paste", (e.clipboardData || {}).files);
  document.addEventListener("change", onChange, true);
  document.addEventListener("drop", onDrop, true);
  document.addEventListener("paste", onPaste, true);

  // Does the page READ the file itself? If it does, the bytes are very likely
  // re-encoded (base64 via readAsDataURL) and inlined into a JSON body rather
  // than PUT as a File — a shape the current guard does NOT handle. Seeing this
  // early explains an upload request whose body reports as a big `string`.
  // Method + file metadata only; the RESULT is never touched.
  const origRead = {};
  for (const m of ["readAsDataURL", "readAsText", "readAsArrayBuffer", "readAsBinaryString"]) {
    if (typeof FileReader === "undefined" || typeof FileReader.prototype[m] !== "function") continue;
    origRead[m] = FileReader.prototype[m];
    FileReader.prototype[m] = function (blob) {
      record("file-read", m, location.href, blob, {
        fileName: (blob && blob.name) || "(blob)",
        mime: (blob && blob.type) || "",
      });
      return origRead[m].apply(this, arguments);
    };
  }

  // Is there a service worker that could be doing the upload out of our reach?
  const swInfo = navigator.serviceWorker
    ? navigator.serviceWorker.getRegistrations().then(
        (rs) => rs.map((r) => ({ scope: r.scope, active: !!r.active })),
        () => "unavailable",
      )
    : Promise.resolve("none");

  /** Bodies big enough that a small text file could be inlined (e.g. base64). */
  const INLINE_BODY_FLOOR = 1024;

  /** Rows that are actual outgoing REQUESTS, not local page events. */
  const NETWORK_VIA = new Set(["fetch", "xhr", "sendBeacon"]);

  /**
   * Does this request look like it CARRIED the file? Shape only — a File/Blob or
   * an ArrayBuffer body, multipart with a File part, or a suspiciously large
   * string/JSON body (the base64-inlined case, judged by SIZE alone since we
   * never read content).
   *
   * Only network rows qualify. The `file-selected` / `file-read` rows also carry
   * a File-shaped body (that is the whole point of them), so without this guard
   * the ATTACH event counts as its own upload — which makes the first "upload"
   * simultaneous with the attach and silently zeroes the attach→upload timing
   * that question 2 depends on.
   */
  const carriesFile = (r) => {
    if (!NETWORK_VIA.has(r.via)) return null;
    const b = r.body || {};
    if (b.kind === "File" || b.kind === "Blob" || b.kind === "ArrayBuffer") return b.kind;
    if (b.kind === "FormData" && (b.parts || []).some((p) => p.kind === "File")) return "FormData";
    if (b.kind === "string" && b.bytes >= INLINE_BODY_FLOOR) return "string?";
    return null;
  };

  /**
   * How confident are we that THIS request is the upload of THAT file?
   *
   * Shape alone is not enough, and Grok proved it: its analytics send `Blob`s to
   * `/api/log_metric` and 9–26 KB JSON strings to `/_data/v1/a/t/`, so a
   * shape-only filter reported a telemetry beacon 5.8s BEFORE the attach as "the
   * first upload" — a NEGATIVE attach→upload gap, and an attach-vs-send verdict
   * that was right only by luck.
   *
   * So candidates are ranked, and the timing conclusion uses only "strong" ones:
   *   strong — sent AFTER the attach, and either carries a File part naming the
   *            attached file or has a body at least as large as it.
   *   weak   — anything else that merely looks file-shaped (usually telemetry).
   * `weakCandidates` is still reported so nothing is hidden.
   */
  const strengthOf = (r, attachRow) => {
    const kind = carriesFile(r);
    if (!kind) return null;
    // Nothing sent before the file existed can be its upload.
    if (!attachRow || r.ms < attachRow.ms) return "weak";
    const attachedBytes = (attachRow.body && attachRow.body.bytes) || 0;
    const attachedName = attachRow.fileName || "";
    const b = r.body || {};
    // Multipart names its parts, so no size guessing is needed.
    if (b.kind === "FormData") {
      const named = (b.parts || []).some((p) => p.kind === "File" && (!attachedName || p.name === attachedName));
      return named ? "strong" : "weak";
    }
    if (!attachedBytes) return "weak";
    // Otherwise size is the only evidence, and the tolerance must depend on the
    // body kind. Grok forced both halves of this: a floor alone ("bigger than the
    // file") promoted its 12 KB JSON analytics, and a shared window still
    // promoted a 3.7 KB `Blob` beacon to /api/log_metric.
    if (b.kind === "File" || b.kind === "Blob" || b.kind === "ArrayBuffer") {
      // A raw binary body is the file ITSELF (ChatGPT PUT exactly 652 bytes for a
      // 652-byte file), so anything but a near-exact size match is other traffic.
      return Math.abs(b.bytes - attachedBytes) <= 64 ? "strong" : "weak";
    }
    // A string body would be the file re-encoded: at least its size, at most a
    // base64 expansion (~1.34x) plus room for surrounding JSON.
    return b.bytes >= attachedBytes && b.bytes <= attachedBytes * 2 + 4096 ? "strong" : "weak";
  };

  /**
   * Does this path segment look like a per-request id rather than a stable route?
   * An id must not go into an endpoint filter — it would match one upload and no
   * other. Heuristic, hence `pathFull` is always reported alongside.
   *
   * A trailing API version (`upload-file-v2`, `list-v2`) is explicitly NOT an id:
   * Grok's real upload path is `/http/upload-file-v2/direct`, and treating `-v2`
   * as an id truncated the suggestion to a useless host-wide `/http/`.
   */
  const idLike = (seg) => {
    if (/-v\d+$/i.test(seg)) return false;
    return /^[0-9]+$/.test(seg) || /^[0-9a-f]{8,}$/i.test(seg) || (/\d/.test(seg) && seg.length >= 6);
  };

  /**
   * The adapter entry this URL implies, as a STARTING POINT to confirm — not an
   * answer. The host is offered as a domain SUFFIX (last two labels) as well as
   * verbatim, because an upload host is often region-specific
   * (`sdmntprcentralindia.oaiusercontent.com`), and hard-coding the one you happen
   * to see breaks every user in another region.
   *
   * `path` keeps up to two leading non-id segments. One segment alone is usually
   * too broad to be a filter (`/rest/` matches every API call on the host), while
   * anything past an id segment is per-request. `pathFull` is included so the
   * heuristic can never hide what was actually observed.
   */
  const suggestEndpoint = (url) => {
    try {
      const u = new URL(url);
      const labels = u.hostname.split(".");
      const segs = u.pathname.split("/").filter(Boolean);
      const keep = [];
      for (const s of segs.slice(0, 2)) {
        if (idLike(s)) break;
        keep.push(s);
      }
      return {
        host: labels.slice(-2).join("."),
        hostSeen: u.hostname,
        path: keep.length ? "/" + keep.join("/") + "/" : "/",
        pathFull: u.pathname,
      };
    } catch {
      return null;
    }
  };

  window.uploadProbe = {
    /** Everything captured, unfiltered. */
    all: () => seen,
    /** Timestamp a manual step — call `mark("sent")` right after pressing send. */
    mark(label) {
      seen.push({ ms: Date.now() - t0, via: "mark", method: String(label || "mark"), url: "", body: { kind: "none" } });
      console.log(`marked "${label}" at ${Date.now() - t0}ms`);
    },
    /** The interesting subset: file events + non-GET requests that carried bytes. */
    async report() {
      const sws = await swInfo;
      const rows = seen.filter(
        (r) =>
          r.via === "file-selected" ||
          r.via === "file-read" ||
          r.via === "mark" ||
          (r.method !== "GET" && r.body && r.body.kind !== "none"),
      );

      // --- the analysis: answer the four questions rather than dump JSON ------
      const attach = seen.find((r) => r.via === "file-selected");
      const sentMark = seen.find((r) => r.via === "mark");
      const describe = (r) => ({
        via: r.via,
        method: r.method,
        url: r.url,
        ms: r.ms,
        bodyKind: carriesFile(r),
        // FormData has no single size; report the sum of its parts so the row is
        // still comparable with the attached file's byte count.
        bytes:
          r.body.kind === "FormData"
            ? (r.body.parts || []).reduce((n, p) => n + (p.bytes || 0), 0)
            : r.body.bytes,
        suggestedEndpoint: suggestEndpoint(r.url),
        // Only a Blob/File body is handled by today's guard + tripwire backstop.
        guardShapeSupported: carriesFile(r) === "File" || carriesFile(r) === "Blob",
      });
      const ranked = seen
        .filter((r) => r.method !== "GET" && carriesFile(r))
        .map((r) => ({ row: r, strength: strengthOf(r, attach) }));
      // Only strong candidates drive the conclusions; weak ones are usually the
      // surface's own analytics and would poison every timing number.
      const uploads = ranked.filter((c) => c.strength === "strong").map((c) => describe(c.row));
      const weakCandidates = ranked.filter((c) => c.strength === "weak").map((c) => describe(c.row));

      const first = uploads[0];
      const summary = {
        // Q1: can page-world code see it at all?
        reachableFromPage: uploads.length > 0,
        viaServiceWorker: Array.isArray(sws) && sws.length > 0 && uploads.length === 0,
        // File-shaped traffic but nothing confidently the upload. Ranking can be
        // wrong in both directions, and "no upload found" is the dangerous
        // reading — it looks like "nothing to guard". Say so instead.
        inconclusive: uploads.length === 0 && weakCandidates.length > 0,
        // Q2: attach-time or send-time?
        attachAtMs: attach ? attach.ms : null,
        firstUploadAtMs: first ? first.ms : null,
        sentAtMs: sentMark ? sentMark.ms : null,
        msFromAttachToUpload: attach && first ? first.ms - attach.ms : null,
        // A large POSITIVE gap here means the bytes left long BEFORE the message
        // was sent, so the guard must hook the attach event — guarding submit
        // would be far too late.
        msFromUploadToSend: first && sentMark ? sentMark.ms - first.ms : null,
        leavesAtAttachTime: !!(first && sentMark && sentMark.ms - first.ms > 1000),
        // Q3 + Q4. Deduped: a surface that retries or chunks would otherwise
        // repeat the same endpoint dozens of times and bury the answer.
        candidateEndpoints: [
          ...new Map(
            uploads.filter((u) => u.suggestedEndpoint).map((u) => [u.suggestedEndpoint.pathFull, u.suggestedEndpoint]),
          ).values(),
        ],
        bodyShapes: [...new Set(uploads.map((u) => u.bodyKind))],
        // A page that reads the file itself is probably re-encoding it (base64),
        // which today's guard does not handle.
        pageReadTheFile: seen.some((r) => r.via === "file-read"),
        needsNewGuardWork: uploads.some((u) => !u.guardShapeSupported) || seen.some((r) => r.via === "file-read"),
      };

      const out = {
        page: location.origin,
        serviceWorkers: sws,
        tripwireInstalled: !String(origFetch).includes("native code"),
        counts: { total: seen.length, reported: rows.length },
        summary,
        uploads,
        // File-shaped but ruled out as the upload (sent before the attach, or
        // smaller than the file). On Grok this is all telemetry. Kept visible so
        // a misranked real upload can still be spotted by hand.
        weakCandidates,
        rows,
      };
      console.log("=== UPLOAD PROBE REPORT (metadata only) ===");
      if (summary.inconclusive) {
        console.warn(
          `INCONCLUSIVE: ${weakCandidates.length} file-shaped request(s) were seen but none ` +
            "confidently carries the attached file. Inspect `weakCandidates` by hand before " +
            "concluding anything — do NOT read this as 'nothing to guard'.",
        );
      } else if (!summary.reachableFromPage) {
        console.warn(
          "No file-carrying request was seen from page world. Either the upload has not " +
            "happened yet, or it is issued out of reach (service worker / native form POST) — " +
            "which would mean this surface CANNOT be guarded the way ChatGPT is.",
        );
      }
      console.log(JSON.stringify(out, null, 2));
      try {
        copy(JSON.stringify(out, null, 2)); // DevTools helper: puts it on the clipboard
        console.log("(copied to clipboard)");
      } catch {}
      return out;
    },
    stop() {
      window.fetch = origFetch;
      XMLHttpRequest.prototype.open = origOpen;
      XMLHttpRequest.prototype.send = origSend;
      if (origBeacon) navigator.sendBeacon = origBeacon;
      for (const m of Object.keys(origRead)) FileReader.prototype[m] = origRead[m];
      document.removeEventListener("change", onChange, true);
      document.removeEventListener("drop", onDrop, true);
      document.removeEventListener("paste", onPaste, true);
      console.log("upload probe removed");
    },
  };

  console.log(
    "upload probe armed.\n" +
      "  1. attach a TEXT file (pii-sample.txt)\n" +
      '  2. send the message, then run: uploadProbe.mark("sent")\n' +
      "  3. run: uploadProbe.report()   <- read `summary` first\n" +
      "NOTE: `tripwireInstalled` tells you whether the extension's wrapper was already " +
      "in place when this probe wrapped fetch (it should be true).",
  );
})();
