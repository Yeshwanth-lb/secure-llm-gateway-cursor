// ===== STREAM REDACTOR (Phase A2) ===========================================
// Outbound SSE holdback core (newplan.md §3.4). Feeds every provider text delta
// into ONE logical channel with a rolling holdback window so PII split across
// chunk boundaries is still caught, then re-serializes protocol-identical events.
import type { Provider } from "./contracts.ts";
import { getRuleSources, redactText } from "./redaction.ts";

interface SseEvent {
  fields: { name: string; value: string }[]; // ordered, preserves event:/id:/retry:/comments
  data: string; // joined multi-line data payload
}

/** Locate the provider's text delta inside a parsed event object (get + set). */
function locateDeltaText(
  provider: Provider,
  obj: unknown,
): { get: () => string; set: (v: string) => void } | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, any>;
  if (provider === "openai") {
    const ch = o.choices?.[0];
    if (ch?.delta && typeof ch.delta.content === "string") {
      return { get: () => ch.delta.content, set: (v) => (ch.delta.content = v) };
    }
    if (typeof ch?.text === "string") {
      return { get: () => ch.text, set: (v) => (ch.text = v) };
    }
  } else if (provider === "anthropic") {
    if (o.delta && typeof o.delta.text === "string") {
      return { get: () => o.delta.text, set: (v) => (o.delta.text = v) };
    }
    if (o.content_block && typeof o.content_block.text === "string") {
      return { get: () => o.content_block.text, set: (v) => (o.content_block.text = v) };
    }
  } else if (provider === "gemini") {
    const part = o.candidates?.[0]?.content?.parts?.[0];
    if (part && typeof part.text === "string") {
      return { get: () => part.text, set: (v) => (part.text = v) };
    }
  }
  return null;
}

function isTerminalEvent(provider: Provider, data: string, obj: unknown): boolean {
  if (data.trim() === "[DONE]") return true;
  const o = (obj ?? {}) as Record<string, any>;
  if (provider === "openai") return o.choices?.[0]?.finish_reason != null;
  if (provider === "anthropic") {
    return o.type === "content_block_stop" || o.type === "message_stop";
  }
  if (provider === "gemini") return o.candidates?.[0]?.finishReason != null;
  return false;
}

export class StreamRedactor {
  readonly provider: Provider;
  readonly holdback: number;
  readonly matched: Record<string, number> = {};

  private raw = ""; // incomplete SSE tail awaiting a frame boundary
  private textTail = ""; // withheld channel text inside the holdback window
  private lastDeltaTemplate: unknown = null; // structure to clone for synthetic flush
  private flushed = false;

  constructor(provider: Provider, holdback: number) {
    this.provider = provider;
    this.holdback = Math.max(0, holdback);
  }

  push(rawChunk: Buffer): Buffer {
    this.raw += rawChunk.toString("utf8");
    let out = "";
    // process only complete events; keep the incomplete tail buffered
    const sep = /\r?\n\r?\n/;
    while (true) {
      const m = sep.exec(this.raw);
      if (!m) break;
      const eventText = this.raw.slice(0, m.index);
      this.raw = this.raw.slice(m.index + m[0].length);
      if (eventText.trim() !== "") out += this.processEvent(eventText);
    }
    return Buffer.from(out, "utf8");
  }

  flush(): Buffer {
    return Buffer.from(this.emitFlush(), "utf8");
  }

  // ---- internals ----------------------------------------------------------

  private mergeMatched(m: Record<string, number>): void {
    for (const k of Object.keys(m)) this.matched[k] = (this.matched[k] ?? 0) + m[k];
  }

  /** Feed channel text; return the redacted portion safe to emit now. */
  private feed(text: string): string {
    const combined = this.textTail + text;
    let cut = Math.max(0, combined.length - this.holdback);
    // never cut inside a match that reaches into the holdback window — defer it
    for (const { rule } of getRuleSources()) {
      const flags = rule.pattern.flags.includes("g")
        ? rule.pattern.flags
        : rule.pattern.flags + "g";
      const re = new RegExp(rule.pattern.source, flags);
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(combined)) !== null) {
        if (mm[0] === "") {
          re.lastIndex++;
          continue;
        }
        if (rule.validate && !rule.validate(mm[0])) continue;
        const end = mm.index + mm[0].length;
        if (end > cut) cut = Math.min(cut, mm.index);
      }
    }
    const emitPart = combined.slice(0, cut);
    this.textTail = combined.slice(cut);
    const r = redactText(emitPart, "outbound");
    this.mergeMatched(r.matched);
    return r.text;
  }

  private parseEvent(eventText: string): SseEvent {
    const fields: { name: string; value: string }[] = [];
    const dataLines: string[] = [];
    for (const line of eventText.split(/\r?\n/)) {
      if (line.startsWith(":")) {
        fields.push({ name: ":comment", value: line.slice(1) });
        continue;
      }
      const ci = line.indexOf(":");
      const name = ci === -1 ? line : line.slice(0, ci);
      let value = ci === -1 ? "" : line.slice(ci + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (name === "data") dataLines.push(value);
      else fields.push({ name, value });
    }
    return { fields, data: dataLines.join("\n") };
  }

  private serialize(prefixFields: { name: string; value: string }[], data: string): string {
    let s = "";
    for (const f of prefixFields) {
      s += f.name === ":comment" ? `:${f.value}\n` : `${f.name}: ${f.value}\n`;
    }
    for (const line of data.split("\n")) s += `data: ${line}\n`;
    return s + "\n";
  }

  private processEvent(eventText: string): string {
    const ev = this.parseEvent(eventText);
    const nonData = ev.fields;

    // terminal signals that carry non-JSON data (OpenAI [DONE]) — flush first
    if (ev.data.trim() === "[DONE]") {
      const pre = this.emitFlush();
      return pre + this.serialize(nonData, ev.data);
    }

    let obj: unknown = null;
    let parsed = false;
    try {
      obj = JSON.parse(ev.data);
      parsed = true;
    } catch {
      // malformed JSON — stateless raw scrub, pass through, never crash (§7)
      const r = redactText(ev.data, "outbound");
      this.mergeMatched(r.matched);
      return this.serialize(nonData, r.text);
    }

    const loc = locateDeltaText(this.provider, obj);
    const terminal = isTerminalEvent(this.provider, ev.data, obj);

    if (loc) {
      this.lastDeltaTemplate = JSON.parse(JSON.stringify(obj)); // structural clone
      const emit = this.feed(loc.get());
      loc.set(emit);
      const body = this.serialize(nonData, JSON.stringify(obj));
      // terminal event that also carries text (Gemini): flush appended right before it
      if (terminal) return this.emitFlush() + body;
      return body;
    }

    // no text channel in this event
    if (terminal) return this.emitFlush() + this.serialize(nonData, JSON.stringify(obj));
    return this.serialize(nonData, parsed ? JSON.stringify(obj) : ev.data);
  }

  /** Release the withheld tail as a synthetic delta cloned from the last delta event. */
  private emitFlush(): string {
    if (this.flushed) return "";
    this.flushed = true;
    if (this.textTail === "") return "";
    const r = redactText(this.textTail, "outbound");
    this.mergeMatched(r.matched);
    this.textTail = "";
    if (this.lastDeltaTemplate) {
      const clone = JSON.parse(JSON.stringify(this.lastDeltaTemplate));
      const loc = locateDeltaText(this.provider, clone);
      if (loc) {
        loc.set(r.text);
        return this.serialize([], JSON.stringify(clone));
      }
    }
    // no template seen — emit a bare data event so nothing is dropped
    return this.serialize([], JSON.stringify({ text: r.text }));
  }
}
