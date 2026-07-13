// ===== OPENAI <-> ANTHROPIC TRANSLATION SHIM (Phase J) ======================
// Cursor's "Override OpenAI Base URL" speaks the OpenAI chat-completions wire
// format. To let Cursor drive Claude *through the gateway* (Cursor has no
// "Override Anthropic Base URL"; setting the OpenAI one on Claude 422s), we
// present an OpenAI-compatible face and translate to the Anthropic Messages API
// underneath. Pure functions + a small streaming reframer — zero deps.
//
// Redaction is unchanged and orthogonal: the proxy scrubs the *translated*
// Anthropic request before forwarding, and scrubs the Anthropic response before
// this module reframes it back to OpenAI. See src/proxy.ts.
export interface TranslateOptions {
  modelMap: Record<string, string>;
  defaultModel: string;
  maxTokens: number;
}

export interface TranslatedRequest {
  body: Record<string, unknown>; // Anthropic Messages request
  model: string; // resolved real (Claude) model — policy-check THIS, not the alias
  stream: boolean;
}

/** Resolve an incoming (OpenAI-style/alias) model id to a real Claude model id.
 *  Map wins first (so a friendly alias like "claude-via-gateway" maps to a real
 *  model), then a genuine "claude-*" id passes through, else the default. */
export function resolveModel(
  incoming: unknown,
  opts: Pick<TranslateOptions, "modelMap" | "defaultModel">,
): string {
  const id = typeof incoming === "string" ? incoming : "";
  const lower = id.toLowerCase();
  if (lower in opts.modelMap) return opts.modelMap[lower];
  if (lower.startsWith("claude")) return id; // already a real Claude id
  return opts.defaultModel;
}

/** Decide whether a request should be translated to Anthropic (vs passed through
 *  to the OpenAI-compatible upstream). True for a "claude-*" id or any configured
 *  translate alias. This is the single-endpoint router: Cursor has one global
 *  base-URL override, so the model id — chosen by the user — is the switch. */
export function shouldTranslate(model: unknown, translateModels: Iterable<string>): boolean {
  const lower = (typeof model === "string" ? model : "").toLowerCase();
  if (lower === "") return false;
  if (lower.startsWith("claude")) return true;
  for (const m of translateModels) if (String(m).toLowerCase() === lower) return true;
  return false;
}

/** Flatten OpenAI message content (string | array of parts) into plain text. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
          // OpenAI vision parts etc. — keep only text; ignore non-text parts.
        }
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * OpenAI chat-completions request -> Anthropic Messages request.
 * - `system` messages are hoisted to the top-level `system` field (joined).
 * - user/assistant messages map 1:1 (content flattened to text blocks).
 * - `max_tokens` is required by Anthropic; falls back to opts.maxTokens.
 * Throws on a structurally invalid request (missing/empty messages) so the
 * proxy can return a clean 400.
 */
export function openaiToAnthropicRequest(
  openai: unknown,
  opts: TranslateOptions,
): TranslatedRequest {
  if (!openai || typeof openai !== "object") {
    throw new Error("request body is not a JSON object");
  }
  const o = openai as Record<string, unknown>;
  if (!Array.isArray(o.messages) || o.messages.length === 0) {
    throw new Error("missing or empty 'messages' array");
  }

  const systemParts: string[] = [];
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of o.messages) {
    if (!m || typeof m !== "object") continue;
    const msg = m as Record<string, unknown>;
    const role = String(msg.role ?? "user");
    const text = contentToText(msg.content);
    if (role === "system") {
      if (text) systemParts.push(text);
    } else if (role === "assistant") {
      messages.push({ role: "assistant", content: text });
    } else {
      // user, tool, function, or anything else -> treat as user turn.
      messages.push({ role: "user", content: text });
    }
  }
  // Anthropic requires a non-empty messages array beginning with a user turn.
  if (messages.length === 0) messages.push({ role: "user", content: " " });
  if (messages[0].role !== "user") messages.unshift({ role: "user", content: " " });

  const model = resolveModel(o.model, opts);
  const stream = o.stream === true;

  const body: Record<string, unknown> = {
    model,
    max_tokens:
      typeof o.max_tokens === "number" && o.max_tokens > 0 ? o.max_tokens : opts.maxTokens,
    messages,
  };
  if (systemParts.length) body.system = systemParts.join("\n\n");
  if (typeof o.temperature === "number") body.temperature = o.temperature;
  if (typeof o.top_p === "number") body.top_p = o.top_p;
  if (stream) body.stream = true;

  return { body, model, stream };
}

const STOP_MAP: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
};

function mapStop(reason: unknown): string {
  const r = typeof reason === "string" ? reason : "";
  return STOP_MAP[r] ?? "stop";
}

/** Collect all text from an Anthropic Messages `content` array. */
function anthropicContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block && typeof block === "object" && (block as any).type === "text") {
      const t = (block as any).text;
      if (typeof t === "string") out += t;
    }
  }
  return out;
}

/**
 * Anthropic Messages response (non-streaming) -> OpenAI chat.completion.
 * `nowSeconds` is injected (not read from the clock here) so callers control it.
 */
export function anthropicToOpenAIResponse(
  anthropic: unknown,
  model: string,
  nowSeconds: number,
): Record<string, unknown> {
  const a = (anthropic ?? {}) as Record<string, unknown>;
  const text = anthropicContentText(a.content);
  const usage = (a.usage ?? {}) as Record<string, unknown>;
  const inTok = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outTok = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  return {
    id: typeof a.id === "string" ? a.id : "chatcmpl-gateway",
    object: "chat.completion",
    created: nowSeconds,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: mapStop(a.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: inTok,
      completion_tokens: outTok,
      total_tokens: inTok + outTok,
    },
  };
}

/**
 * Streaming reframer: consumes *redacted* Anthropic SSE (as emitted by
 * StreamRedactor with provider "anthropic") and emits OpenAI
 * chat.completion.chunk SSE. Stateless w.r.t. redaction — text has already been
 * scrubbed upstream. Buffers partial events on the `\n\n` boundary.
 */
export class AnthropicToOpenAISSE {
  private buf = "";
  private started = false;
  private finish = "stop";
  private done = false;
  private readonly id: string;
  private readonly model: string;
  private readonly created: number;

  constructor(model: string, created: number, id = "chatcmpl-gateway") {
    this.model = model;
    this.created = created;
    this.id = id;
  }

  private chunk(delta: Record<string, unknown>, finish: string | null): string {
    const payload = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  push(rawChunk: Buffer): Buffer {
    this.buf += rawChunk.toString("utf8");
    let out = "";
    const sep = /\r?\n\r?\n/;
    while (true) {
      const m = sep.exec(this.buf);
      if (!m) break;
      const eventText = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      if (eventText.trim() !== "") out += this.translateEvent(eventText);
    }
    return Buffer.from(out, "utf8");
  }

  flush(): Buffer {
    let out = "";
    if (this.buf.trim() !== "") {
      out += this.translateEvent(this.buf);
      this.buf = "";
    }
    out += this.finalize();
    return Buffer.from(out, "utf8");
  }

  // ---- internals ----------------------------------------------------------

  private finalize(): string {
    if (this.done) return "";
    this.done = true;
    let out = "";
    if (!this.started) {
      // Degenerate stream with no message_start seen — still emit a role chunk.
      out += this.chunk({ role: "assistant" }, null);
    }
    out += this.chunk({}, this.finish);
    out += "data: [DONE]\n\n";
    return out;
  }

  private translateEvent(eventText: string): string {
    // Extract the `data:` payload (ignore `event:`/`id:` lines — OpenAI is
    // data-only). Multi-line data is joined.
    const dataLines: string[] = [];
    for (const line of eventText.split(/\r?\n/)) {
      if (line.startsWith(":")) continue; // comment
      const ci = line.indexOf(":");
      const name = ci === -1 ? line : line.slice(0, ci);
      let value = ci === -1 ? "" : line.slice(ci + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (name === "data") dataLines.push(value);
    }
    const data = dataLines.join("\n");
    if (data.trim() === "" || data.trim() === "[DONE]") return "";

    let obj: any;
    try {
      obj = JSON.parse(data);
    } catch {
      return ""; // non-JSON keepalive/comment — drop from the OpenAI stream
    }

    const type = obj?.type;
    switch (type) {
      case "message_start": {
        this.started = true;
        return this.chunk({ role: "assistant" }, null);
      }
      case "content_block_delta": {
        const d = obj.delta ?? {};
        // text_delta -> content; thinking_delta has no OpenAI equivalent (drop).
        if (typeof d.text === "string" && d.type !== "thinking_delta") {
          if (!this.started) {
            this.started = true;
            return this.chunk({ role: "assistant" }, null) + this.chunk({ content: d.text }, null);
          }
          return this.chunk({ content: d.text }, null);
        }
        return "";
      }
      case "message_delta": {
        const sr = obj.delta?.stop_reason;
        if (typeof sr === "string") this.finish = mapStop(sr);
        return "";
      }
      case "message_stop": {
        return this.finalize();
      }
      default:
        // content_block_start / content_block_stop / ping -> no OpenAI output.
        return "";
    }
  }
}
