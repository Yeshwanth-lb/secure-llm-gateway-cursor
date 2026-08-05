// ===== GROK SURFACE — headless tests =======================================
// grok.com is the third surface behind the hostname-scoped adapter table
// (extension/src/site-adapter.js). It reuses ChatGPT's hard-won machinery
// wholesale — Grok's composer is Tiptap, which IS ProseMirror — so the risk here
// is not new mechanics but WIRING: an adapter that leaks its selectors onto a
// neighbouring surface, or a tripwire that silently doesn't cover the new one.
// What is checked headlessly, mirroring tests/phase-chatgpt.test.ts:
//
//   1. HOST SCOPING. grok.com must resolve to the Grok adapter, and the three
//      adapters must share no selectors and no endpoint fragments. A generic
//      selector matching the wrong element is not cosmetic — it once returned a
//      search box as the "composer", read "" as the prompt, and let an
//      UNREDACTED send through (Sheets, 2026-07-21).
//   2. THE COMPOSER TARGET. Grok builds its request from the ProseMirror model,
//      so a <textarea> must never be a composer target: writing one is accepted
//      by the DOM, changes nothing that ships, and puts the RAW prompt on the
//      wire. Exactly the trap ChatGPT's hidden companion textarea sets.
//   3. THE TRIPWIRE'S ENDPOINT LIST. Grok's conversation POST must be inspected,
//      or the DOM-independent fail-closed net is absent there — and the fragment
//      must survive the per-conversation id in the path.
//   4. THE LOG ROW. Grok turns log as provider "openai" (xAI has no member in the
//      FROZEN Provider enum) and are told apart by source "grok-web-extension",
//      with only REDACTED text stored.
//
// The browser-gated behavior (real ProseMirror write, real re-fire) is covered by
// `npm run test:grok-e2e`. PII fixtures are assembled from fragments so no full
// literal appears in source (repo convention).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "../secure-llm-gateway.ts";
import {
  adapterForHost,
  adapterById,
  GEMINI_ADAPTER,
  CHATGPT_ADAPTER,
  GROK_ADAPTER,
} from "../extension/src/site-adapter.js";
import {
  shouldInspectUrl,
  bodyLooksRaw,
  installTripwire,
  DEFAULT_ENDPOINTS,
  DEFAULT_GEMINI_ENDPOINTS,
  DEFAULT_CHATGPT_ENDPOINTS,
  DEFAULT_GROK_ENDPOINTS,
} from "../extension/src/tripwire.js";

const EMAIL = "dana" + "@" + "corp.example";
const SSN = "078-" + "05-" + "1120";

let server: ReturnType<typeof createGatewayServer>;
let base: string;

before(async () => {
  server = createGatewayServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});

// --- HAPPY -------------------------------------------------------------------
test("happy: grok.com resolves to the Grok adapter, and its tier label becomes a log slug", () => {
  for (const host of ["grok.com", "www.grok.com"]) {
    assert.equal(adapterForHost(host).id, "grok", `${host} must use the Grok adapter`);
  }
  assert.equal(adapterById("grok"), GROK_ADAPTER);

  // The composer is the Tiptap/ProseMirror contenteditable.
  assert.ok(
    GROK_ADAPTER.composerSelectors.some((s) => /tiptap/i.test(s)),
    "the Tiptap composer must be in the fast path",
  );

  // The tier/model button's text is what the log row shows.
  assert.equal(GROK_ADAPTER.normalizeModel("Fast"), "grok-fast");
  assert.equal(GROK_ADAPTER.normalizeModel("Expert"), "grok-expert");
  assert.equal(GROK_ADAPTER.normalizeModel("Grok 4"), "grok-4", "an already-Grok label is not double-prefixed");
  assert.equal(GROK_ADAPTER.normalizeModel(""), null, "no label -> caller falls back");
  assert.equal(GROK_ADAPTER.fallbackModel, "grok");

  // Neighbouring surfaces are unchanged.
  assert.equal(adapterForHost("chatgpt.com").id, "chatgpt");
  assert.equal(adapterForHost("gemini.google.com").id, "gemini");
  assert.equal(CHATGPT_ADAPTER.normalizeModel("GPT-4o"), "gpt-4o");
  assert.equal(GEMINI_ADAPTER.normalizeModel("2.5 Flash"), "gemini-flash");
});

test("happy: a Grok turn logs as provider openai / source grok-web-extension with only redacted text stored", async () => {
  const res = await fetch(`${base}/log-turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: `mail ${EMAIL} and confirm ${SSN}`,
      response: "Done — I sent the note.",
      model: "grok-expert",
      provider: GROK_ADAPTER.provider,
      source: GROK_ADAPTER.source,
    }),
  });
  assert.equal(res.status, 200);

  const logs = await (await fetch(`${base}/logs?clean=1`)).json();
  const entry = logs.entries.find((e: any) => e.path === "grok-web-extension");
  assert.ok(entry, "the Grok turn is in the traffic log");
  // xAI has no Provider enum member and the enum is FROZEN, so Grok shares the
  // "openai" API-family bucket with ChatGPT/Cursor. `source` is the only thing
  // that tells the surfaces apart — if it collided, two surfaces would be
  // indistinguishable in an audit log.
  assert.equal(entry.provider, "openai");
  assert.notEqual(GROK_ADAPTER.source, CHATGPT_ADAPTER.source, "same provider bucket, so source must differ");
  assert.equal(entry.model, "grok-expert");
  assert.equal(entry.method, "CHAT");
  assert.equal(entry.piiDetected, true);
  assert.ok(entry.matchedRules.inbound.EMAIL >= 1);
  assert.ok(entry.matchedRules.inbound.SSN >= 1);

  // Never persist raw PII — the whole entry, snapshot and clean view included.
  const stored = JSON.stringify(entry);
  assert.ok(!stored.includes("corp.example"), "raw email must not be stored");
  assert.ok(!stored.includes(SSN), "raw SSN must not be stored");
  assert.match(entry.clean.userPrompt, /\[REDACTED_PII_EMAIL\]/);
  assert.match(entry.clean.userPrompt, /\[REDACTED_PII_SSN\]/);
  assert.equal(entry.clean.assistantOutput, "Done — I sent the note.");
});

// --- FAILURE -----------------------------------------------------------------
test("failure: raw PII on Grok's conversation endpoint is aborted, and no <textarea> is ever a composer", () => {
  // Both message paths must be inspected, whatever the conversation id is, or the
  // fail-closed net is silently absent on Grok.
  assert.ok(shouldInspectUrl("https://grok.com/rest/app-chat/conversations/new"));
  assert.ok(
    shouldInspectUrl("https://grok.com/rest/app-chat/conversations/8f3c1d9a-0000-4c2b-9a11-abcdef123456/load-responses"),
    "the fragment must survive an arbitrary conversation id",
  );

  // And a raw body there must actually be blocked (fetch + XHR), as on the others.
  const events: string[] = [];
  const win: any = {
    fetch: () => Promise.resolve("sent"),
    dispatchEvent: (e: any) => events.push(e?.detail?.reason ?? ""),
    XMLHttpRequest: class {
      open() {}
      send() {
        return "sent";
      }
    },
    CustomEvent: class {
      detail: unknown;
      constructor(_t: string, o: any) {
        this.detail = o?.detail;
      }
    },
  };
  installTripwire(win, { endpoints: DEFAULT_GROK_ENDPOINTS });

  // Grok ships the typed text as the JSON `message` field with sender "human".
  const rawBody = JSON.stringify({ message: `write to ${EMAIL}`, sender: "human" });
  assert.ok(bodyLooksRaw(rawBody), "the body genuinely contains raw PII");
  assert.rejects(
    () => win.fetch("https://grok.com/rest/app-chat/conversations/new", { method: "POST", body: rawBody }),
    /blocked by PII tripwire/,
  );

  const xhr = new win.XMLHttpRequest();
  xhr.open("POST", "https://grok.com/rest/app-chat/conversations/abc/load-responses");
  assert.throws(() => xhr.send(rawBody), /blocked by PII tripwire/);
  assert.ok(events.includes("tripwire-fetch") && events.includes("tripwire-xhr"), JSON.stringify(events));

  // Grok builds the outgoing request from the ProseMirror document model, so a
  // <textarea> write is accepted by the DOM and ships the RAW prompt anyway —
  // proven on ChatGPT, and the same editor family here. Only the contenteditable
  // may ever be targeted.
  for (const sel of GROK_ADAPTER.composerSelectors) {
    assert.ok(!/(?:^|[\s,>+~(])textarea\b/i.test(sel), `must not match a <textarea> element: ${sel}`);
    assert.ok(/contenteditable/i.test(sel), `must target the contenteditable editor: ${sel}`);
  }
});

test("failure: Grok's non-chat traffic is not inspected, and x.com is not claimed as a Grok surface", () => {
  // The false-positive class that once forced the tripwire off entirely for
  // Google's analytics (§7.7): only the conversation family is in scope.
  for (const url of [
    "https://grok.com/rest/auth/get-user",
    "https://grok.com/rest/rate-limits",
    "https://grok.com/api/statsig/initialize",
    "https://assets.grok.com/users/avatar.png",
  ]) {
    assert.ok(!shouldInspectUrl(url, DEFAULT_GROK_ENDPOINTS), `${url} must not be inspected`);
  }

  // Grok on x.com/twitter.com is a DIFFERENT DOM and deliberately out of scope.
  // It must not be claimed here: doing so would run Grok's grok.com selectors on
  // a page they were never verified against — the wrong-element leak class. It
  // falls through to the Gemini fail-safe default, and since x.com is not in the
  // manifest either, the extension never runs there at all.
  assert.equal(adapterForHost("x.com").id, "gemini");
  assert.equal(adapterForHost("twitter.com").id, "gemini");
  assert.ok(!GROK_ADAPTER.hosts.some((h) => /x\.com|twitter/.test(h)));

  // And an unmapped host still falls back rather than silently disarming.
  assert.equal(adapterForHost("some-new-surface.example").id, "gemini");
});

// --- EDGE --------------------------------------------------------------------
test("edge: the three surfaces share no selectors or endpoint fragments, and Grok's reply is captured by shape", () => {
  const overlap = (a: string[], b: string[]) => a.filter((x) => b.includes(x));
  for (const [name, other] of [
    ["gemini", GEMINI_ADAPTER],
    ["chatgpt", CHATGPT_ADAPTER],
  ] as const) {
    assert.deepEqual(overlap(GROK_ADAPTER.tripwireEndpoints, other.tripwireEndpoints), [], `endpoints vs ${name}`);
  }

  // Composer selectors are the one place a small overlap is CORRECT rather than a
  // bug: Grok and ChatGPT run the same editor, so both list the generic
  // `div.ProseMirror[contenteditable="true"]`. That is safe because a list only
  // ever runs on its own host — the adapter is hostname-keyed. What must hold is
  // that neither surface can be identified by the OTHER's specific selector, and
  // that Gemini shares nothing with either.
  assert.deepEqual(overlap(GROK_ADAPTER.composerSelectors, GEMINI_ADAPTER.composerSelectors), []);
  assert.deepEqual(overlap(CHATGPT_ADAPTER.composerSelectors, GEMINI_ADAPTER.composerSelectors), []);
  assert.deepEqual(
    overlap(GROK_ADAPTER.composerSelectors, CHATGPT_ADAPTER.composerSelectors),
    ['div.ProseMirror[contenteditable="true"]'],
    "the ONLY shared composer selector may be the generic ProseMirror one",
  );
  // Gemini's Quill/appsElements selectors must not be reachable from Grok...
  assert.ok(!GROK_ADAPTER.composerSelectors.some((s) => /ql-editor|Ask Gemini/i.test(s)));
  // ...ChatGPT's identifying `#prompt-textarea` must not be reachable from Grok...
  assert.ok(!GROK_ADAPTER.composerSelectors.some((s) => /prompt-textarea/i.test(s)));
  // ...and neither surface's editor selectors may be reachable from Gemini.
  assert.ok(!GEMINI_ADAPTER.composerSelectors.some((s) => /ProseMirror|tiptap/i.test(s)));
  assert.ok(!CHATGPT_ADAPTER.composerSelectors.some((s) => /tiptap/i.test(s)));

  // Endpoint scoping cuts every way: a Grok URL is invisible to the other two
  // lists and vice-versa, while the unscoped union still covers all three.
  const grokUrl = "https://grok.com/rest/app-chat/conversations/new";
  const chatgptUrl = "https://chatgpt.com/backend-api/conversation";
  const geminiUrl = "https://gemini.google.com/_/BardChatUi/data/StreamGenerate";
  assert.ok(!shouldInspectUrl(grokUrl, DEFAULT_CHATGPT_ENDPOINTS));
  assert.ok(!shouldInspectUrl(grokUrl, DEFAULT_GEMINI_ENDPOINTS));
  assert.ok(!shouldInspectUrl(chatgptUrl, DEFAULT_GROK_ENDPOINTS));
  assert.ok(!shouldInspectUrl(geminiUrl, DEFAULT_GROK_ENDPOINTS));
  for (const url of [grokUrl, chatgptUrl, geminiUrl]) {
    assert.ok(shouldInspectUrl(url, DEFAULT_ENDPOINTS), `${url} must be covered by the unscoped default`);
  }

  // Grok marks the assistant turn with NOTHING semantic — rotating Tailwind
  // classes and `<span class="animate-gaussian">` word spans — so the reply is
  // captured by SHAPE (response-capture.js), the mechanism already proven on
  // Gemini's equally class-name-free Gmail/Drive/Chat panels. An unconfirmed
  // selector here would be tried FIRST, ahead of the shape path, and one that
  // happened to match the user's own bubble would log the wrong text as the
  // assistant output. Add a selector only once it is read off the live DOM.
  assert.deepEqual(GROK_ADAPTER.responseSelectors, []);

  // Grok renders no status label inside the reply node, so label handling must be
  // skipped rather than fall back to Gemini's ("Gemini response"/"Show thinking").
  assert.equal(GROK_ADAPTER.responseLabelOnly, null);
  assert.equal(GROK_ADAPTER.responseLabelPrefix, null);
  // And it must not body-scan for a model: on Grok the body IS the transcript, so
  // a stray "fast"/"expert" inside a reply would be logged as the model.
  assert.equal(GROK_ADAPTER.modelBodyPattern, null);
  assert.ok(GEMINI_ADAPTER.modelBodyPattern instanceof RegExp, "Gemini keeps its header scan");

  // Uploads were PROBED live 2026-07-31 (two agreeing runs), so the attach-time
  // guard is now armed. The endpoint is the measured one: same-origin, and
  // specific enough to exclude Grok's Blob/JSON analytics.
  assert.equal(GROK_ADAPTER.uploadGuard, true);
  assert.deepEqual(GROK_ADAPTER.uploadEndpoints, [{ host: "grok.com", path: "/upload-file-v2/" }]);
  // Gemini's upload flow was PROBED live 2026-08-03 (Blob POST to
  // push.clients6.google.com/upload/), so its guard is now armed too. The endpoint
  // is pinned to `clients6.google.com` + `/upload/`, precise enough to exclude the
  // play.google.com/log + batchexecute + analytics noise the probe showed.
  assert.equal(GEMINI_ADAPTER.uploadGuard, true);
  assert.deepEqual(GEMINI_ADAPTER.uploadEndpoints, [{ host: "clients6.google.com", path: "/upload/" }]);
});
