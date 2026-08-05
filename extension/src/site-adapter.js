// ===== SITE ADAPTER — per-surface selectors, one shared machinery ===========
// Everything site-SPECIFIC (composer/send/stop/model/response selectors, the
// generate endpoints the tripwire inspects, and how a turn is labelled in the
// gateway log) lives here, keyed by HOSTNAME. Everything site-AGNOSTIC — the
// loop guard (interceptor-core.js), the composer scorer/learner, the reply
// scorer, the tripwire's detection, the bridge/background messaging — is shared
// and untouched by adding a surface.
//
// Why a hostname-scoped table rather than one growing selector list: a selector
// that only makes sense on ChatGPT must never be tried on a Gemini page (and
// vice-versa). A stray generic match on the wrong element is not a cosmetic bug
// here — it once returned a search box as the "composer", read "" as the prompt,
// and let an UNREDACTED send through (Sheets, 2026-07-21). Scoping by host
// removes that whole class of failure.
//
// FAIL-SAFE DEFAULT: an unrecognized host resolves to the GEMINI adapter, which
// is exactly the behavior before ChatGPT existed. The manifest is what decides
// where the extension runs at all; this table only decides how to read the page.
//
// Design refs: extension/CHATGPT_EXTENSION.md §3/§4, extension/GROK_EXTENSION.md,
// scripts/gemini_imp.md §4.1.

/** Lowercase + collapse a model label into a log-friendly slug. */
function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// --- gemini.google.com + the Google Workspace "Ask Gemini" side panel --------
export const GEMINI_ADAPTER = {
  id: "gemini",
  // Provider/source for the gateway's /log-turn row. `provider` must stay inside
  // the FROZEN Provider enum; `source` is free-form and is what the console shows.
  provider: "gemini",
  source: "gemini-web-extension",
  hosts: ["gemini.google.com", "mail.google.com", "docs.google.com", "drive.google.com", "chat.google.com"],

  // FAST-PATH composer selectors — Gemini/Workspace-SPECIFIC and high-confidence
  // ONLY. Deliberately NO generic catch-alls (`div[role=textbox]`, bare
  // `textarea`): a blind generic match can return the WRONG sane element before
  // the stronger focus/learned signals run, which leaked raw PII in the
  // Layer-1.5 e2e. Generic editables are ranked by the fallback instead.
  composerSelectors: [
    'div.ql-editor[contenteditable="true"]', // gemini.google.com — Quill editor
    "rich-textarea .ql-editor",
    // Workspace apps (Gmail/Docs/Sheets/Slides/Drive/Chat) — appsElements composer.
    'div[contenteditable="true"][aria-label*="Ask Gemini" i]',
  ],

  // Ordered, most-specific-first candidates for the send control.
  sendButtonSelectors: [
    "button.send-button",
    'button[aria-label*="Send" i]',
    'button[aria-label*="Submit" i]',
    'button[mattooltip*="Send" i]',
    '[data-test-id="send-button"], [data-testid*="send" i]',
    'button:has(mat-icon[fonticon="send"])',
    "button:has(mat-icon)",
  ],
  // Used by fireSubmit to pick the ENABLED + VISIBLE control: Workspace renders a
  // DISABLED decoy `aria-label="Submit"` beside the real one (live 2026-07-21).
  liveSendSelector:
    'button.send-button, button[aria-label="Submit" i], button[aria-label*="Send message" i], button[aria-label*="Send" i]',
  // A VISIBLE stop control means the model is still generating. Dialog buttons say
  // "Cancel"/"Close", which are deliberately NOT matched (false positives).
  stopSelector:
    'button[aria-label*="Stop" i], button[mattooltip*="Stop" i], [role="button"][aria-label*="Stop" i]',

  modelSelectors: [
    '[data-test-id="bard-mode-menu-button"]',
    "bard-mode-switcher button",
    '[aria-label*="model" i] .logo-pill-label-container',
    ".logo-pill-label-container",
  ],
  // Last resort: scan the top of the page for a tier word. Safe on Gemini, where
  // the header carries it; NOT safe on a surface whose body is the transcript.
  modelBodyPattern: /\b(flash|pro|ultra|nano)\b/i,
  fallbackModel: "gemini",
  normalizeModel(text) {
    const m = String(text).match(/\b(flash|pro|ultra|nano|advanced|thinking)\b/i);
    return m ? "gemini-" + m[1].toLowerCase() : null;
  },

  // STABLE, semantic response selectors only: gemini.google.com's response markup
  // and Docs/Sheets/Slides' appsElements agent-message classes. Gmail/Drive/Chat
  // rotate their class names every deploy and are covered by the shape-based
  // capture (response-capture.js) instead — never by a generic "last listitem"
  // guess, which reliably grabs a suggestion chip.
  responseSelectors: [
    "message-content .markdown",
    ".model-response-text .markdown",
    ".model-response-text",
    "message-content",
    ".response-container .markdown",
    ".appsElementsSidekickAgentMessageBubbleContent",
    "[class*='SidekickAgentMessageBubbleContent']",
    "[class*='SidekickAgentMessage']",
    ".appsElementsSidekickAgentMessageRoot",
  ],
  // Status labels Gemini renders inside the reply node. `LabelOnly` = the whole
  // text is just a label (still a placeholder, not the answer); `LabelPrefix` is
  // stripped from the text we store.
  responseLabelOnly: /^(gemini response|model thoughts|show thinking)$/i,
  responseLabelPrefix: /^(gemini response|show thinking|model thoughts)\s*/i,

  // Substrings identifying the prompt/generate request for the tripwire. Tunable
  // like the selectors — CONFIRM against the live Network tab if sends break.
  //
  // FILE UPLOADS — probed live on gemini.google.com 2026-08-03
  // (upload-probe-console.js):
  //
  //   file-selected  input.change  pii-sample.txt  652 B  text/plain
  //   xhr POST https://push.clients6.google.com/upload/   (init, 25 B string)
  //   xhr POST https://push.clients6.google.com/upload/   body: Blob 652 B  <- the file
  //   message sent                                        (~17s LATER)
  //
  // Attach-time (bytes leave ~2s after `change`, 17s before the send), page-issued
  // XHR (`serviceWorkers:[]`), and the body is a raw Blob of exactly the file size
  // — the ChatGPT shape the guard already handles. So the guard hooks
  // change/drop/paste and the tripwire backstop inspects the Blob on the wire.
  //
  // Endpoint pinned to `clients6.google.com` (suffix, robust to the `push.` label)
  // + path `/upload/`: nothing else Gemini fires uses that path, so the noisy
  // `play.google.com/log`, `batchexecute`, and analytics the probe showed are all
  // excluded.
  //
  // SCOPE CAVEAT: this adapter also backs the Workspace panels (Gmail/Docs/Drive/
  // Chat), whose upload endpoint was NOT probed and is likely different. The
  // PRIMARY guard is endpoint-independent — it swaps the File at attach time, so it
  // still scrubs a Workspace attach — but the wire BACKSTOP only covers the probed
  // gemini.google.com endpoint there. Probe a Workspace panel the same way before
  // trusting the backstop on it.
  uploadGuard: true,
  uploadEndpoints: [{ host: "clients6.google.com", path: "/upload/" }],

  tripwireEndpoints: [
    "/BardChatUi/",
    "StreamGenerate",
    "assistant.lamda",
    "BardFrontendService",
    "batchexecute",
    // Workspace side panel (verified live 2026-07-21): lowercase `streamGenerate`
    // on the appsgenaiservice host. `includes` is case-sensitive, so the
    // capitalized Bard form above does NOT cover it.
    "streamGenerate",
    "appsgenaiservice",
  ],
};

// --- chatgpt.com (OpenAI ChatGPT) -------------------------------------------
// Every selector below was confirmed against the LIVE page on 2026-07-30 via
// `npm run probe:chatgpt` (see extension/CHATGPT_COVERAGE.md).
export const CHATGPT_ADAPTER = {
  id: "chatgpt",
  // ChatGPT logs as provider "openai" — its API family, and already a valid
  // Provider (Cursor turns use it too), so the gateway needs no change.
  provider: "openai",
  source: "chatgpt-web-extension",
  hosts: ["chatgpt.com", "chat.openai.com"],

  // The composer is a ProseMirror contenteditable with a STABLE id. The page also
  // contains a hidden `textarea[name="prompt-textarea"]`
  // (`wcDTda_fallbackTextarea`) — deliberately NOT listed: the probe proved the
  // outgoing request is built from ProseMirror's model, so writing the textarea
  // updates nothing that ships and the RAW prompt goes out. Only the
  // contenteditable may be written.
  composerSelectors: [
    'div#prompt-textarea[contenteditable="true"]',
    '#prompt-textarea[contenteditable="true"]',
    'div.ProseMirror[contenteditable="true"]',
  ],

  sendButtonSelectors: [
    'button[data-testid="send-button"]',
    'button[data-testid="fruitjuice-send-button"]', // older build
    'button[aria-label="Send prompt" i]',
    'button[aria-label*="Send" i]',
    "button.composer-submit-btn",
  ],
  liveSendSelector:
    'button[data-testid="send-button"], button[data-testid="fruitjuice-send-button"], button[aria-label*="Send" i], button.composer-submit-btn',
  // While generating, the send button is replaced by a stop button.
  stopSelector: 'button[data-testid="stop-button"], button[aria-label*="Stop" i]',

  modelSelectors: ['[data-testid="model-switcher-dropdown-button"]', '[data-testid*="model-switcher"]'],
  // No body scan: on ChatGPT the page body IS the transcript, so a stray "pro" or
  // "mini" in a reply would be logged as the model.
  modelBodyPattern: null,
  fallbackModel: "chatgpt",
  normalizeModel(text) {
    const t = String(text).replace(/\s+/g, " ").trim();
    if (!t) return null;
    if (/^gpt/i.test(t)) return slug(t); // "GPT-4o" -> "gpt-4o"
    const rest = t.replace(/^chatgpt\s*/i, "").trim();
    // "ChatGPT" -> "chatgpt"; "ChatGPT 5 Thinking" -> "chatgpt-5-thinking".
    return rest ? "chatgpt-" + slug(rest) : /^chatgpt$/i.test(t) ? "chatgpt" : null;
  },

  // Unlike Gemini's obfuscated panels, ChatGPT marks each turn semantically with
  // `data-message-author-role`, so the selector path covers it; the shape-based
  // fallback stays available but should not be needed.
  responseSelectors: [
    '[data-message-author-role="assistant"] .markdown',
    '[data-message-author-role="assistant"] [data-message-content]',
    '[data-message-author-role="assistant"]',
  ],
  // ChatGPT renders no status label inside the reply node.
  responseLabelOnly: null,
  responseLabelPrefix: null,

  // FILE UPLOADS — probed live 2026-07-30 (CHATGPT_COVERAGE.md §6). The bytes go
  // out as an XHR PUT whose body is the File, to a REGION-SPECIFIC host
  // (`sdmntprcentralindia.oaiusercontent.com`), ~19s BEFORE the message is sent.
  // Hence the host is matched as a domain suffix, never hard-coded, and the guard
  // hooks the attach event rather than submit.
  uploadGuard: true,
  uploadEndpoints: [{ host: "oaiusercontent.com", path: "/files/" }],

  // The message POST. Confirmed live: chatgpt.com/backend-api/conversation.
  // `/backend-api/f/conversation` and `/backend-alt/conversation` are the other
  // paths OpenAI has shipped; all three are listed because a path change must not
  // silently disable the fail-closed net.
  tripwireEndpoints: ["/backend-api/conversation", "/backend-api/f/conversation", "/backend-alt/conversation"],
};

// --- grok.com (xAI Grok) ----------------------------------------------------
// Grok's composer is Tiptap, which IS ProseMirror — the same editor family as
// ChatGPT — so the write path in composer.js (execCommand insertText, proven on
// ChatGPT's wire) applies unchanged. Spec: extension/GROK_EXTENSION.md.
export const GROK_ADAPTER = {
  id: "grok",
  // xAI has no member in the FROZEN Provider enum, so Grok logs under the
  // "openai" API-family bucket like ChatGPT and Cursor do. `source` is what
  // actually distinguishes the surface in the console.
  provider: "openai",
  source: "grok-web-extension",
  // grok.com only. Grok on x.com/twitter.com is a DIFFERENT DOM and is
  // deliberately out of scope until probed separately.
  hosts: ["grok.com"],

  // Tiptap/ProseMirror contenteditable, most-specific first. NO <textarea>
  // fallback: Grok builds the outgoing request from the ProseMirror model, so
  // writing a textarea would change nothing that ships and the RAW prompt would
  // go out — the same trap ChatGPT's hidden companion textarea sets.
  composerSelectors: [
    'div.tiptap.ProseMirror[contenteditable="true"]',
    'div.ProseMirror[contenteditable="true"]',
  ],

  // Grok uses unlabeled icon buttons, so the submit/aria candidates are
  // best-effort; fireSubmit falls back to a synthetic Enter, which is the
  // reliable path on every surface.
  sendButtonSelectors: [
    'button[type="submit"]',
    'button[aria-label*="Submit" i]',
    'button[aria-label*="Send" i]',
  ],
  liveSendSelector:
    'button[type="submit"], button[aria-label*="Submit" i], button[aria-label*="Send" i]',
  // While generating, the send control becomes a stop (square) button.
  stopSelector: 'button[aria-label*="Stop" i], button[data-testid*="stop" i]',

  // The tier/model button next to the composer ("Fast" / "Expert"). UNVERIFIED
  // best-effort — Grok's controls are unlabeled icon buttons, so if none match,
  // `fallbackModel` is used. This is a log-row cosmetic, never a security path.
  modelSelectors: [
    'button[aria-label*="model" i]',
    'button[data-testid*="model" i]',
    '[role="button"][aria-haspopup="menu"][aria-label*="Grok" i]',
  ],
  // No body scan: on Grok the page body IS the transcript, so a stray "fast" or
  // "expert" inside a reply would be logged as the model (same rule as ChatGPT).
  modelBodyPattern: null,
  fallbackModel: "grok",
  normalizeModel(text) {
    const t = String(text).replace(/\s+/g, " ").trim();
    if (!t) return null;
    // Already a Grok model id ("Grok 4", "grok-4-fast") — slug it as-is.
    if (/^grok/i.test(t)) return slug(t);
    return "grok-" + slug(t);
  },

  // DELIBERATELY EMPTY — the reply is captured by SHAPE, not by selector.
  // Grok marks the assistant turn with nothing semantic: the bubbles are
  // Tailwind utility classes that rotate per build and the streamed answer is
  // assembled from `<span class="animate-gaussian">` word spans. No candidate
  // could be CONFIRMED against the live page, and an unverified guess here is
  // worse than none — it would be tried FIRST, ahead of the shape path, and a
  // selector that happens to match the user's own bubble logs the wrong text as
  // the assistant output. So capture falls straight through to
  // response-capture.js, the mechanism already proven on Gemini's equally
  // class-name-free Gmail/Drive/Chat panels. Add a selector here only once it
  // has been read off the live DOM.
  responseSelectors: [],
  responseLabelOnly: null,
  responseLabelPrefix: null,

  // Grok's upload flow has NOT been probed (the ChatGPT probe showed the bytes
  // leave at attach time, ~19s before the send — that has to be measured per
  // surface). Arming an unprobed guard risks breaking attachments to close a gap
  // Probed live 2026-07-31 with `upload-probe-console.js`, two agreeing runs:
  //
  //   file-selected  input.change  pii-sample.txt  652 B  text/plain
  //   fetch POST https://grok.com/http/upload-file-v2/direct
  //              body: FormData -> [{ field:"file", File "pii-sample.txt", 652 B }]
  //   message sent                                            (~24s LATER)
  //
  // Attach-time like ChatGPT but tighter — 35ms after the `change` event (ChatGPT
  // took 259ms) — so the guard hooks change/drop/paste, and attaching a file then
  // removing it before sending has already leaked it.
  //
  // Unlike ChatGPT the host is same-origin and NOT region-sharded, so no domain
  // suffix trick is needed. `/upload-file-v2/` is specific enough to exclude the
  // rest of Grok's traffic, including the `/api/log_metric` + `/_data/v1/a/t/`
  // analytics that carry Blobs and fat JSON.
  uploadGuard: true,
  uploadEndpoints: [{ host: "grok.com", path: "/upload-file-v2/" }],

  // The message POST, confirmed live by searching the Network tab for the typed
  // text: `POST /rest/app-chat/conversations/{id}/load-responses` for follow-ups
  // and `POST /rest/app-chat/conversations/new` for the first message. The shared
  // PREFIX covers both plus any future per-conversation path, and is robust to
  // the conversation id.
  tripwireEndpoints: ["/rest/app-chat/conversations/"],
};

// --- chat.deepseek.com (DeepSeek) -------------------------------------------
// The EASIEST composer of any surface and the WEAKEST wire backstop. Probed live
// 2026-08-03. Two findings define this adapter (spec: extension/DEEPSEEK_EXTENSION.md):
//
//   1. The composer is a PLAIN <textarea> (probe: isTextarea:true, no ProseMirror,
//      no Lexical). So unlike ChatGPT/Grok, the composer IS a textarea here — the
//      native-setter + input-event write path in composer.js handles it directly,
//      the most reliable write we have. This is the ONE adapter whose composer
//      selectors deliberately target a <textarea>.
//   2. DeepSeek ENCRYPTS/signs the outgoing request body — a Network-panel search
//      for the typed text found NOTHING, and the request list carries
//      `create_pow_challenge` + `sha3_wasm` (a WASM proof-of-work). The tripwire
//      scans the outbound body for raw PII, so against ciphertext it is BLIND: it
//      can neither confirm the redaction nor abort a raw send on DeepSeek. The
//      endpoint is listed anyway (harmless; covers the case DeepSeek ever sends
//      plaintext), but the real protection here is the composer intercept, which
//      for a plain textarea is reliable. This limitation is recorded in the ledger.
export const DEEPSEEK_ADAPTER = {
  id: "deepseek",
  // DeepSeek ships an OpenAI-compatible API and has no member in the FROZEN
  // Provider enum, so it logs under the "openai" bucket like ChatGPT/Grok/Cursor.
  // `source` is what distinguishes the surface in the console.
  provider: "openai",
  source: "deepseek-web-extension",
  // chat.deepseek.com only.
  hosts: ["chat.deepseek.com"],

  // A PLAIN <textarea> — the only surface whose composer is one. The probed
  // element carried a HASHED class (`_27c9245 ds-scroll-area …`) that rotates per
  // build, so it is NOT selected on; a stable id and the visible placeholder are.
  // No contenteditable path: DeepSeek's composer is genuinely a textarea, and the
  // textarea write in composer.js updates React's value tracking correctly.
  composerSelectors: [
    'textarea#chat-input',
    'textarea[placeholder*="Message DeepSeek" i]',
  ],

  // Unlabeled up-arrow send control; the Enter path is the reliable submit gesture
  // (fireSubmit falls back to it), so these are best-effort.
  sendButtonSelectors: [
    'button[type="submit"]',
    'div[role="button"][aria-label*="Send" i]',
  ],
  liveSendSelector: 'button[type="submit"], div[role="button"][aria-label*="Send" i]',
  stopSelector: 'button[aria-label*="Stop" i], div[role="button"][aria-label*="Stop" i]',

  // The tier label near the composer ("Instant"/"Thinking") + a model switcher.
  // Best-effort and cosmetic; getModel falls back to `fallbackModel` if none hit.
  modelSelectors: ['button[aria-label*="model" i]', 'div[role="button"][aria-label*="model" i]'],
  // No body scan: on DeepSeek the page body IS the transcript, so a stray tier word
  // inside a reply would be logged as the model (same rule as ChatGPT/Grok).
  modelBodyPattern: null,
  fallbackModel: "deepseek",
  normalizeModel(text) {
    const t = String(text).replace(/\s+/g, " ").trim();
    if (!t) return null;
    // Already a DeepSeek id ("DeepSeek-V3") — slug as-is; else prefix the tier.
    if (/^deepseek/i.test(t)) return slug(t);
    return "deepseek-" + slug(t); // "Instant" -> "deepseek-instant"
  },

  // DeepSeek renders each turn in a `ds-message` wrapper and the answer as markdown
  // in a `.ds-markdown` block. These are semantic-enough to try first; the
  // shape-based capture (response-capture.js) is the fallback, as on Grok. VERIFY
  // against the live ASSISTANT bubble — the `ds-*` classes carry hashed siblings.
  responseSelectors: [".ds-markdown", ".ds-markdown--block", "[class*='ds-markdown']"],
  responseLabelOnly: null,
  responseLabelPrefix: null,

  // Upload flow PROBED live 2026-08-03 (upload-probe-console.js, on real
  // chat.deepseek.com, signed in):
  //
  //   file-selected  input.change  pii-block-test.txt  150 B  text/plain
  //   xhr POST https://chat.deepseek.com/api/v0/file/upload_file
  //            body: FormData -> [{ field:"file", File, name preserved }]
  //   message sent                                        (~12.2s LATER)
  //
  // Attach-time (13ms after `change`), page-issued (`serviceWorkers:[]`), and the
  // body is multipart FormData with a `file` part — the same shape as Grok, which
  // `uploadBlobsOf` already unpacks, so no new guard work. So the guard hooks
  // change/drop/paste (NOT submit — the bytes leave long before the send), and the
  // tripwire backstop inspects the FormData file part on the wire.
  //
  // The host is same-origin and NOT region-sharded, so no suffix trick is strictly
  // needed, but it is matched as a domain SUFFIX anyway. `/file/upload_file` is
  // specific enough to exclude `/chat/completion` and the noisy `gator.volces.com`
  // (ByteDance/Volcano) telemetry the probe showed flooding `/list` on attach.
  uploadGuard: true,
  uploadEndpoints: [{ host: "deepseek.com", path: "/file/upload_file" }],

  // The message send is the `completion` request (xhr). Confirmed path family:
  // POST https://chat.deepseek.com/api/v0/chat/completion. The body is ENCRYPTED
  // (see the header comment), so this backstop is BEST-EFFORT on DeepSeek — the
  // composer intercept is the real protection. The fragment survives a `s` suffix
  // (`/chat/completions`) since `includes` is a substring test.
  tripwireEndpoints: ["/chat/completion"],
};

// GEMINI stays LAST: it is the fail-safe default for an unrecognized host, so
// every more specific adapter has to be matched before it.
const ADAPTERS = [CHATGPT_ADAPTER, GROK_ADAPTER, DEEPSEEK_ADAPTER, GEMINI_ADAPTER];

/** Does `hostname` belong to `adapter` (exact host or a subdomain of one)? */
function hostMatches(adapter, hostname) {
  return adapter.hosts.some((h) => hostname === h || hostname.endsWith("." + h));
}

/**
 * The adapter for a hostname. Unknown hosts fall back to GEMINI — the behavior
 * that existed before other surfaces were added, so a manifest host nobody
 * mapped here keeps working (fail-safe) instead of silently disarming.
 */
export function adapterForHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return ADAPTERS.find((a) => hostMatches(a, h)) || GEMINI_ADAPTER;
}

/** The adapter for the current page. */
export function getAdapter(loc = typeof location !== "undefined" ? location : { hostname: "" }) {
  return adapterForHost(loc && loc.hostname);
}

/** Look an adapter up by id ("gemini" | "chatgpt" | "grok" | "deepseek"), or null. Used by the e2e
 *  harnesses, whose fake pages are served from 127.0.0.1 and so cannot be
 *  identified by hostname. */
export function adapterById(id) {
  return ADAPTERS.find((a) => a.id === id) || null;
}
