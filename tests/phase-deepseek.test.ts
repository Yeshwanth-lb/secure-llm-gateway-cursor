// ===== DEEPSEEK SURFACE — headless tests ====================================
// chat.deepseek.com is the fourth surface behind the hostname-scoped adapter
// table (extension/src/site-adapter.js). It is unusual in two ways that these
// tests pin down, mirroring tests/phase-grok.test.ts:
//
//   1. THE COMPOSER IS A <textarea>. Every other surface's composer is a
//      contenteditable (Quill/ProseMirror) and its selectors must NOT match a
//      textarea. DeepSeek is the inverse: its composer genuinely IS a textarea,
//      so its selectors MUST target one and must NOT target a contenteditable.
//      Getting this backwards would make findComposer miss the real box.
//   2. THE WIRE IS ENCRYPTED. DeepSeek signs/encrypts the request body (WASM
//      proof-of-work), so the tripwire is BLIND on the live surface — it cannot
//      read a ciphertext body. The endpoint is still listed (harmless, and covers
//      a future plaintext body), and these tests exercise the readable-body path
//      to prove the WIRING is correct; the encrypted-body limitation is a
//      documented property, recorded in the ledger, not something a unit test can
//      reproduce.
//
// Also checked, as for every surface: host scoping (no selector/endpoint leaks
// across surfaces), the log row (provider "openai", source
// "deepseek-web-extension", redacted text only), and reply capture.
//
// PII fixtures are assembled from fragments so no full literal appears in source.

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
  DEEPSEEK_ADAPTER,
} from "../extension/src/site-adapter.js";
import { isUploadUrl } from "../extension/src/upload-core.js";
import {
  shouldInspectUrl,
  bodyLooksRaw,
  installTripwire,
  DEFAULT_ENDPOINTS,
  DEFAULT_GEMINI_ENDPOINTS,
  DEFAULT_CHATGPT_ENDPOINTS,
  DEFAULT_GROK_ENDPOINTS,
  DEFAULT_DEEPSEEK_ENDPOINTS,
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
test("happy: chat.deepseek.com resolves to the DeepSeek adapter, and its tier label becomes a log slug", () => {
  for (const host of ["chat.deepseek.com", "www.chat.deepseek.com"]) {
    assert.equal(adapterForHost(host).id, "deepseek", `${host} must use the DeepSeek adapter`);
  }
  assert.equal(adapterById("deepseek"), DEEPSEEK_ADAPTER);

  // The composer is a plain <textarea> — the ONLY surface whose fast-path targets
  // one. It must be found by a stable handle (id/placeholder), never the hashed class.
  assert.ok(
    DEEPSEEK_ADAPTER.composerSelectors.every((s) => /textarea/i.test(s)),
    "every DeepSeek composer selector must target a <textarea>",
  );
  assert.ok(
    DEEPSEEK_ADAPTER.composerSelectors.some((s) => /placeholder\*?=.*deepseek/i.test(s)),
    "the visible placeholder is a stable handle and must be one of the selectors",
  );

  // The tier label ("Instant"/"Thinking") is what the log row shows.
  assert.equal(DEEPSEEK_ADAPTER.normalizeModel("Instant"), "deepseek-instant");
  assert.equal(DEEPSEEK_ADAPTER.normalizeModel("Thinking"), "deepseek-thinking");
  assert.equal(
    DEEPSEEK_ADAPTER.normalizeModel("DeepSeek-V3"),
    "deepseek-v3",
    "an already-DeepSeek label is not double-prefixed",
  );
  assert.equal(DEEPSEEK_ADAPTER.normalizeModel(""), null, "no label -> caller falls back");
  assert.equal(DEEPSEEK_ADAPTER.fallbackModel, "deepseek");

  // Neighbouring surfaces are unchanged.
  assert.equal(adapterForHost("grok.com").id, "grok");
  assert.equal(adapterForHost("chatgpt.com").id, "chatgpt");
  assert.equal(adapterForHost("gemini.google.com").id, "gemini");
});

test("happy: a DeepSeek turn logs as provider openai / source deepseek-web-extension with only redacted text stored", async () => {
  const res = await fetch(`${base}/log-turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: `mail ${EMAIL} and confirm ${SSN}`,
      response: "Done — noted.",
      model: "deepseek-instant",
      provider: DEEPSEEK_ADAPTER.provider,
      source: DEEPSEEK_ADAPTER.source,
    }),
  });
  assert.equal(res.status, 200);

  const logs = await (await fetch(`${base}/logs?clean=1`)).json();
  const entry = logs.entries.find((e: any) => e.path === "deepseek-web-extension");
  assert.ok(entry, "the DeepSeek turn is in the traffic log");
  // DeepSeek has no Provider enum member and the enum is FROZEN, so it shares the
  // "openai" API-family bucket. `source` is the only thing telling the surfaces
  // apart — a collision would make two surfaces indistinguishable in an audit log.
  assert.equal(entry.provider, "openai");
  assert.notEqual(DEEPSEEK_ADAPTER.source, CHATGPT_ADAPTER.source, "same provider bucket, so source must differ");
  assert.notEqual(DEEPSEEK_ADAPTER.source, GROK_ADAPTER.source, "same provider bucket, so source must differ");
  assert.equal(entry.model, "deepseek-instant");
  assert.equal(entry.method, "CHAT");
  assert.equal(entry.piiDetected, true);
  assert.ok(entry.matchedRules.inbound.EMAIL >= 1);
  assert.ok(entry.matchedRules.inbound.SSN >= 1);

  // Never persist raw PII — snapshot and clean view included.
  const stored = JSON.stringify(entry);
  assert.ok(!stored.includes("corp.example"), "raw email must not be stored");
  assert.ok(!stored.includes(SSN), "raw SSN must not be stored");
  assert.match(entry.clean.userPrompt, /\[REDACTED_PII_EMAIL\]/);
  assert.match(entry.clean.userPrompt, /\[REDACTED_PII_SSN\]/);
  assert.equal(entry.clean.assistantOutput, "Done — noted.");
});

// --- FAILURE -----------------------------------------------------------------
test("failure: raw PII on DeepSeek's completion endpoint is aborted when the body is readable, and the composer is a textarea", () => {
  // The completion send must be inspected whatever the exact path — and the
  // fragment must survive a `s` suffix (`/chat/completions`), since it is a
  // substring test.
  assert.ok(shouldInspectUrl("https://chat.deepseek.com/api/v0/chat/completion", DEFAULT_DEEPSEEK_ENDPOINTS));
  assert.ok(
    shouldInspectUrl("https://chat.deepseek.com/api/v0/chat/completions", DEFAULT_DEEPSEEK_ENDPOINTS),
    "the fragment must survive the plural `/completions` form",
  );

  // The tripwire wiring itself works on a READABLE body (fetch + XHR). On the live
  // surface DeepSeek encrypts the body, so this net is blind there — that is a
  // documented limitation, not a test we can write; here we prove the mechanism is
  // connected for the case a plaintext body is ever sent.
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
  installTripwire(win, { endpoints: DEFAULT_DEEPSEEK_ENDPOINTS });

  const rawBody = JSON.stringify({ messages: [{ role: "user", content: `write to ${EMAIL}` }] });
  assert.ok(bodyLooksRaw(rawBody), "the body genuinely contains raw PII");
  assert.rejects(
    () => win.fetch("https://chat.deepseek.com/api/v0/chat/completion", { method: "POST", body: rawBody }),
    /blocked by PII tripwire/,
  );
  const xhr = new win.XMLHttpRequest();
  xhr.open("POST", "https://chat.deepseek.com/api/v0/chat/completions");
  assert.throws(() => xhr.send(rawBody), /blocked by PII tripwire/);
  assert.ok(events.includes("tripwire-fetch") && events.includes("tripwire-xhr"), JSON.stringify(events));

  // DeepSeek's composer IS a <textarea> (probed live), so — unlike every other
  // surface — its selectors MUST target one and must NOT target a contenteditable
  // (which would miss the real box entirely).
  for (const sel of DEEPSEEK_ADAPTER.composerSelectors) {
    assert.ok(/(?:^|[\s,>+~(])textarea\b/i.test(sel), `must match a <textarea> element: ${sel}`);
    assert.ok(!/contenteditable/i.test(sel), `must NOT target a contenteditable: ${sel}`);
  }
});

test("failure: DeepSeek's non-chat traffic is not inspected, and only chat.deepseek.com is claimed", () => {
  // Only the completion family is in scope — DeepSeek's auth/analytics/POW traffic
  // must not be inspected (the false-positive class §7.7).
  for (const url of [
    "https://chat.deepseek.com/api/v0/users/current",
    "https://chat.deepseek.com/api/v0/chat/create_pow_challenge",
    "https://chat.deepseek.com/api/v0/chat_session/fetch_page",
    "https://cdn.deepseek.com/assets/logo.png",
  ]) {
    assert.ok(!shouldInspectUrl(url, DEFAULT_DEEPSEEK_ENDPOINTS), `${url} must not be inspected`);
  }

  // The marketing/root domains are a DIFFERENT surface and out of scope; they fall
  // through to the Gemini fail-safe default, and are not in the manifest either.
  assert.equal(adapterForHost("deepseek.com").id, "gemini");
  assert.equal(adapterForHost("platform.deepseek.com").id, "gemini");
  assert.deepEqual(DEEPSEEK_ADAPTER.hosts, ["chat.deepseek.com"]);
});

// --- EDGE --------------------------------------------------------------------
test("edge: the four surfaces share no selectors or endpoint fragments, and DeepSeek reads by ds-markdown", () => {
  const overlap = (a: string[], b: string[]) => a.filter((x) => b.includes(x));
  for (const [name, other] of [
    ["gemini", GEMINI_ADAPTER],
    ["chatgpt", CHATGPT_ADAPTER],
    ["grok", GROK_ADAPTER],
  ] as const) {
    assert.deepEqual(overlap(DEEPSEEK_ADAPTER.tripwireEndpoints, other.tripwireEndpoints), [], `endpoints vs ${name}`);
    // DeepSeek's textarea composer selectors can't collide with the others'
    // contenteditable ones, but assert it anyway — a future edit must not sneak a
    // shared selector in.
    assert.deepEqual(overlap(DEEPSEEK_ADAPTER.composerSelectors, other.composerSelectors), [], `composer vs ${name}`);
  }

  // Endpoint scoping cuts every way: a DeepSeek URL is invisible to the other
  // lists and vice-versa, while the unscoped union still covers all four.
  const deepseekUrl = "https://chat.deepseek.com/api/v0/chat/completion";
  const grokUrl = "https://grok.com/rest/app-chat/conversations/new";
  const chatgptUrl = "https://chatgpt.com/backend-api/conversation";
  const geminiUrl = "https://gemini.google.com/_/BardChatUi/data/StreamGenerate";
  assert.ok(!shouldInspectUrl(deepseekUrl, DEFAULT_GEMINI_ENDPOINTS));
  assert.ok(!shouldInspectUrl(deepseekUrl, DEFAULT_CHATGPT_ENDPOINTS));
  assert.ok(!shouldInspectUrl(deepseekUrl, DEFAULT_GROK_ENDPOINTS));
  assert.ok(!shouldInspectUrl(grokUrl, DEFAULT_DEEPSEEK_ENDPOINTS));
  assert.ok(!shouldInspectUrl(chatgptUrl, DEFAULT_DEEPSEEK_ENDPOINTS));
  assert.ok(!shouldInspectUrl(geminiUrl, DEFAULT_DEEPSEEK_ENDPOINTS));
  for (const url of [deepseekUrl, grokUrl, chatgptUrl, geminiUrl]) {
    assert.ok(shouldInspectUrl(url, DEFAULT_ENDPOINTS), `${url} must be covered by the unscoped default`);
  }

  // DeepSeek renders the answer as markdown in a `.ds-markdown` block, so unlike
  // Grok it has semantic response selectors to try first; the shape capture stays
  // the fallback. They must be ds-markdown-anchored (not a hashed sibling class).
  assert.ok(DEEPSEEK_ADAPTER.responseSelectors.length > 0);
  assert.ok(
    DEEPSEEK_ADAPTER.responseSelectors.every((s) => /ds-markdown/i.test(s)),
    "response selectors must be anchored on the stable ds-markdown class",
  );

  // No status label inside the reply node, and no model body scan (the body is the
  // transcript).
  assert.equal(DEEPSEEK_ADAPTER.responseLabelOnly, null);
  assert.equal(DEEPSEEK_ADAPTER.responseLabelPrefix, null);
  assert.equal(DEEPSEEK_ADAPTER.modelBodyPattern, null);

  // Upload flow PROBED live 2026-08-03 (attach-time FormData POST to
  // /api/v0/file/upload_file), so the attach-time guard is armed. The endpoint is
  // the measured one, matched as a domain suffix + specific path.
  assert.equal(DEEPSEEK_ADAPTER.uploadGuard, true);
  assert.deepEqual(DEEPSEEK_ADAPTER.uploadEndpoints, [{ host: "deepseek.com", path: "/file/upload_file" }]);
  // It must match the real upload URL...
  assert.ok(
    isUploadUrl("https://chat.deepseek.com/api/v0/file/upload_file", DEEPSEEK_ADAPTER.uploadEndpoints),
    "the real DeepSeek upload URL must be recognized",
  );
  // ...and NOTHING else DeepSeek fires on attach: not the chat send, and not the
  // ByteDance/Volcano `gator.volces.com/list` telemetry flood the probe showed.
  for (const url of [
    "https://chat.deepseek.com/api/v0/chat/completion",
    "https://chat.deepseek.com/api/v0/chat/create_pow_challenge",
    "https://gator.volces.com/list",
  ]) {
    assert.ok(!isUploadUrl(url, DEEPSEEK_ADAPTER.uploadEndpoints), `${url} must NOT be treated as an upload`);
  }
});
