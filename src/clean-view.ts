// ===== CLEAN VIEW ===========================================================
// Distills a log entry's redacted snapshots down to what a human cares about:
// the actual USER prompt and the ASSISTANT output — stripping the boilerplate
// Claude Code injects (<system-reminder> blocks that carry CLAUDE.md/context,
// the `system` array, tool definitions, envelope fields). Pure functions over
// the ALREADY-REDACTED snapshots — never touches raw PII. Best-effort: if a
// snapshot was truncated (SNAPSHOT_CHARS) parsing may be partial; we say so.
import type { LogEntry, Provider } from "./contracts.ts";

/** Remove Claude Code's injected wrappers from a user-authored text block. */
function stripBoilerplate(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<\/?session>/gi, "")
    .replace(/<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/gi, "")
    .replace(/<command-[^>]*>[\s\S]*?<\/command-[^>]*>/gi, "")
    .trim();
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as any).text === "string" ? (b as any).text : ""))
      .join("");
  }
  return "";
}

/** The real user prompt(s): user-role messages with boilerplate stripped. */
export function extractUserPrompt(reqSnapshot: string): string {
  let obj: any;
  try {
    obj = JSON.parse(reqSnapshot);
  } catch {
    return "(could not parse request — snapshot may be truncated; raise SNAPSHOT_CHARS)";
  }
  const msgs = Array.isArray(obj?.messages) ? obj.messages : [];
  const parts: string[] = [];
  for (const m of msgs) {
    if (m?.role !== "user") continue;
    const cleaned = stripBoilerplate(blockText(m.content));
    if (cleaned) parts.push(cleaned);
  }
  return parts.join("\n\n---\n\n") || "(no user text found)";
}

/** The assistant output: concatenated text deltas (SSE) or message text (JSON). */
export function extractAssistantOutput(provider: Provider, respSnapshot: string): string {
  const s = respSnapshot.trim();
  if (s === "") return "(empty)";

  // streaming SSE — accumulate per-provider text deltas from each data: line.
  if (/(^|\n)\s*(event:|data:)/.test(s)) {
    let out = "";
    for (const line of s.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim();
      if (d === "[DONE]" || d === "") continue;
      let j: any;
      try {
        j = JSON.parse(d);
      } catch {
        continue; // truncated / partial tail event
      }
      if (provider === "anthropic" && j?.type === "content_block_delta" && typeof j.delta?.text === "string") {
        out += j.delta.text;
      } else if (provider === "openai" && typeof j?.choices?.[0]?.delta?.content === "string") {
        out += j.choices[0].delta.content;
      } else if (provider === "gemini") {
        const t = j?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof t === "string") out += t;
      }
    }
    return out || "(no assistant text recovered — snapshot may be truncated)";
  }

  // buffered JSON response.
  try {
    const j = JSON.parse(s);
    if (provider === "anthropic" && Array.isArray(j?.content)) {
      return j.content.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("") || "(no text)";
    }
    if (provider === "openai") {
      const c = j?.choices?.[0];
      if (typeof c?.message?.content === "string") return c.message.content;
      if (typeof c?.text === "string") return c.text;
    }
    if (provider === "gemini") {
      const t = j?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof t === "string") return t;
    }
    return "(no assistant text found)";
  } catch {
    return "(could not parse response — snapshot may be truncated)";
  }
}

/** Attach a distilled { userPrompt, assistantOutput } view to a log entry. */
export function cleanEntry(e: LogEntry): LogEntry & {
  clean: { userPrompt: string; assistantOutput: string };
} {
  return {
    ...e,
    // Prefer the capture-time distillation (from the full body); fall back to
    // parsing the truncated snapshot for older/hook entries that lack it.
    clean: e.clean ?? {
      userPrompt: extractUserPrompt(e.payloadSnapshot.request),
      assistantOutput: extractAssistantOutput(e.provider, e.payloadSnapshot.response),
    },
  };
}
