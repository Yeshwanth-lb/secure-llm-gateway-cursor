// ===== CHATGPT SURFACE — headless tests ====================================
// Adding chatgpt.com to the extension moved every site-specific selector into a
// HOSTNAME-SCOPED adapter (extension/src/site-adapter.js) so the two surfaces
// share the interceptor, the composer finder/learner, the reply scorer and the
// tripwire's detection without sharing selectors. What is easy to regress
// silently — and expensive when it happens, because the failure mode is an
// unredacted send — is checked here, headlessly:
//
//   1. HOST SCOPING. A ChatGPT selector must never be tried on a Gemini page and
//      vice-versa. A generic selector matching the wrong element already caused a
//      live leak once (Sheets' empty `role=textbox`, 2026-07-21).
//   2. THE COMPOSER TARGET. ChatGPT ships a hidden companion
//      `textarea[name="prompt-textarea"]`. Writing it is accepted by the DOM and
//      changes NOTHING that ships — the request is built from the ProseMirror
//      model, so a "fix" that prefers the textarea leaks the raw prompt. Proven
//      live 2026-07-30 (`npm run probe:chatgpt`); locked in here.
//   3. THE TRIPWIRE'S ENDPOINT LIST. If ChatGPT's conversation endpoint is not
//      inspected, the DOM-independent fail-closed net is silently absent there.
//   4. THE LOG ROW. ChatGPT turns log as provider "openai" (its API family, an
//      existing Provider value) with only REDACTED text stored.
//
// The browser-gated behavior (real ProseMirror, real re-fire) is covered by
// `npm run test:chatgpt-e2e`. PII fixtures are assembled from fragments so no
// full literal appears in source (repo convention).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "../secure-llm-gateway.ts";
import { adapterForHost, adapterById, GEMINI_ADAPTER, CHATGPT_ADAPTER } from "../extension/src/site-adapter.js";
import {
  shouldInspectUrl,
  bodyLooksRaw,
  installTripwire,
  DEFAULT_ENDPOINTS,
  DEFAULT_GEMINI_ENDPOINTS,
  DEFAULT_CHATGPT_ENDPOINTS,
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
test("happy: chatgpt hosts resolve to the ChatGPT adapter, and its model label becomes a log slug", () => {
  for (const host of ["chatgpt.com", "www.chatgpt.com", "chat.openai.com"]) {
    assert.equal(adapterForHost(host).id, "chatgpt", `${host} must use the ChatGPT adapter`);
  }
  // The composer is the ProseMirror contenteditable with a stable id.
  assert.ok(
    CHATGPT_ADAPTER.composerSelectors.some((s) => s.includes("#prompt-textarea")),
    "the ProseMirror composer must be in the fast path",
  );

  // The model switcher's text is what the log row shows.
  assert.equal(CHATGPT_ADAPTER.normalizeModel("ChatGPT"), "chatgpt");
  assert.equal(CHATGPT_ADAPTER.normalizeModel("ChatGPT 5 Thinking"), "chatgpt-5-thinking");
  assert.equal(CHATGPT_ADAPTER.normalizeModel("GPT-4o"), "gpt-4o");
  assert.equal(CHATGPT_ADAPTER.normalizeModel(""), null, "no label -> caller falls back");
  assert.equal(CHATGPT_ADAPTER.fallbackModel, "chatgpt");

  // Gemini's behavior is unchanged.
  assert.equal(adapterForHost("gemini.google.com").id, "gemini");
  assert.equal(GEMINI_ADAPTER.normalizeModel("2.5 Flash"), "gemini-flash");
  assert.equal(GEMINI_ADAPTER.fallbackModel, "gemini");
});

test("happy: a ChatGPT turn logs as provider openai with only redacted text stored", async () => {
  const res = await fetch(`${base}/log-turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: `mail ${EMAIL} and confirm ${SSN}`,
      response: "Done — I sent the note.",
      model: "chatgpt-5-thinking",
      provider: CHATGPT_ADAPTER.provider,
      source: CHATGPT_ADAPTER.source,
    }),
  });
  assert.equal(res.status, 200);

  const logs = await (await fetch(`${base}/logs?clean=1`)).json();
  const entry = logs.entries.find((e: any) => e.path === "chatgpt-web-extension");
  assert.ok(entry, "the ChatGPT turn is in the traffic log");
  assert.equal(entry.provider, "openai", "ChatGPT logs under its API family (frozen Provider enum untouched)");
  assert.equal(entry.model, "chatgpt-5-thinking");
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
test("failure: raw PII on ChatGPT's conversation endpoint is aborted, and the companion textarea is never a composer", () => {
  // The endpoint must be inspected, or the fail-closed net is absent on ChatGPT.
  assert.ok(shouldInspectUrl("https://chatgpt.com/backend-api/conversation"));
  assert.ok(shouldInspectUrl("https://chatgpt.com/backend-api/f/conversation"));
  assert.ok(shouldInspectUrl("https://chatgpt.com/backend-alt/conversation"));

  // And a raw body there must actually be blocked (fetch + XHR), as on Gemini.
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
  installTripwire(win, { endpoints: DEFAULT_CHATGPT_ENDPOINTS });

  const rawBody = JSON.stringify({ messages: [{ content: { parts: [`write to ${EMAIL}`] } }] });
  assert.ok(bodyLooksRaw(rawBody), "the body genuinely contains raw PII");
  assert.rejects(
    () => win.fetch("https://chatgpt.com/backend-api/conversation", { method: "POST", body: rawBody }),
    /blocked by PII tripwire/,
  );

  const xhr = new win.XMLHttpRequest();
  xhr.open("POST", "https://chatgpt.com/backend-api/conversation");
  assert.throws(() => xhr.send(rawBody), /blocked by PII tripwire/);
  assert.ok(events.includes("tripwire-fetch") && events.includes("tripwire-xhr"), JSON.stringify(events));

  // The hidden `textarea[name="prompt-textarea"]` accepts a value but the request
  // is built from the ProseMirror model, so writing it puts the RAW prompt on the
  // wire (proven live). It must never appear as a composer target. Note the real
  // composer's id IS "prompt-textarea" while being a <div>, so this checks the
  // selector's ELEMENT position, plus the textarea's own identifying attributes.
  for (const sel of CHATGPT_ADAPTER.composerSelectors) {
    assert.ok(!/(?:^|[\s,>+~(])textarea\b/i.test(sel), `must not match a <textarea> element: ${sel}`);
    assert.ok(!/fallbackTextarea|name=/i.test(sel), `must not target the companion textarea: ${sel}`);
    assert.ok(/contenteditable/i.test(sel), `must target the contenteditable editor: ${sel}`);
  }
});

test("failure: an unrecognized host falls back to Gemini rather than disarming", () => {
  // A manifest host nobody mapped here must keep working exactly as before
  // ChatGPT existed — silently having NO adapter would mean no selectors, hence
  // no interception, on a page the extension was deliberately loaded into.
  assert.equal(adapterForHost("docs.google.com").id, "gemini");
  assert.equal(adapterForHost("some-new-surface.example").id, "gemini");
  assert.equal(adapterForHost("").id, "gemini");
  assert.equal(adapterForHost(undefined as unknown as string).id, "gemini");
  assert.equal(adapterById("nope"), null);
});

// --- EDGE --------------------------------------------------------------------
test("edge: the two surfaces share no selectors and no endpoint fragments", () => {
  // A ChatGPT selector on a Gemini page (or the reverse) is the failure mode the
  // adapter exists to prevent: a wrong "composer" reads "" and the send goes out
  // unredacted. Assert the lists are genuinely disjoint.
  const overlap = (a: string[], b: string[]) => a.filter((x) => b.includes(x));
  assert.deepEqual(overlap(CHATGPT_ADAPTER.composerSelectors, GEMINI_ADAPTER.composerSelectors), []);
  assert.deepEqual(overlap(CHATGPT_ADAPTER.responseSelectors, GEMINI_ADAPTER.responseSelectors), []);
  assert.deepEqual(overlap(CHATGPT_ADAPTER.tripwireEndpoints, GEMINI_ADAPTER.tripwireEndpoints), []);

  // Gemini's Quill/appsElements selectors must not be reachable from ChatGPT.
  assert.ok(!CHATGPT_ADAPTER.composerSelectors.some((s) => /ql-editor|Ask Gemini/i.test(s)));
  // ChatGPT's ProseMirror id must not be reachable from Gemini.
  assert.ok(!GEMINI_ADAPTER.composerSelectors.some((s) => /prompt-textarea|ProseMirror/i.test(s)));

  // Endpoint scoping cuts both ways: a Gemini generate URL is not inspected by
  // the ChatGPT list, and a ChatGPT URL is not inspected by the Gemini list.
  const geminiUrl = "https://gemini.google.com/_/BardChatUi/data/StreamGenerate";
  const chatgptUrl = "https://chatgpt.com/backend-api/conversation";
  assert.ok(!shouldInspectUrl(geminiUrl, DEFAULT_CHATGPT_ENDPOINTS));
  assert.ok(!shouldInspectUrl(chatgptUrl, DEFAULT_GEMINI_ENDPOINTS));
  // The union default still covers both, so a caller that doesn't scope is safe.
  assert.ok(shouldInspectUrl(geminiUrl, DEFAULT_ENDPOINTS));
  assert.ok(shouldInspectUrl(chatgptUrl, DEFAULT_ENDPOINTS));

  // ChatGPT's telemetry and account traffic must NOT be inspected — the
  // false-positive class that once forced the tripwire off entirely for Google's
  // analytics (§7.7). Only the conversation family is in scope.
  for (const url of [
    "https://chatgpt.com/backend-api/me",
    "https://chatgpt.com/backend-api/models",
    "https://chatgpt.com/ces/v1/t",
    "https://ab.chatgpt.com/v1/rgstr",
  ]) {
    assert.ok(!shouldInspectUrl(url), `${url} must not be inspected`);
  }
  // `shouldInspectUrl` matches by SUBSTRING (unchanged, site-agnostic), so the
  // fragment also covers the sibling `/backend-api/conversations…` list/search
  // paths. That is deliberate and safe in this direction: those are GETs with no
  // body (`bodyLooksRaw("")` is false, so nothing is aborted), and anything in the
  // conversation family that DID carry raw PII is exactly what should be blocked.
  assert.ok(shouldInspectUrl("https://chatgpt.com/backend-api/conversations?offset=0"));
  assert.equal(bodyLooksRaw(""), false, "a bodyless request is never aborted");

  // ChatGPT has no in-reply status label, so label handling must be skipped
  // rather than fall back to Gemini's ("Gemini response"/"Show thinking").
  assert.equal(CHATGPT_ADAPTER.responseLabelOnly, null);
  assert.equal(CHATGPT_ADAPTER.responseLabelPrefix, null);
  // And it must not body-scan for a model: on ChatGPT the body IS the transcript,
  // so a "pro"/"mini" inside a reply would be logged as the model.
  assert.equal(CHATGPT_ADAPTER.modelBodyPattern, null);
  assert.ok(GEMINI_ADAPTER.modelBodyPattern instanceof RegExp, "Gemini keeps its header scan");
});
