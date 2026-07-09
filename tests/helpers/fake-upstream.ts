// Test helper: a local fake LLM provider. Records what the gateway forwarded
// (so tests can assert inbound redaction) and replies in JSON or SSE mode
// (so tests can assert outbound redaction). Zero deps — node:http only.
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Received {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface FakeUpstream {
  base: string;
  received: Received[];
  last(): Received | undefined;
  close(): Promise<void>;
}

// Response mode is chosen by the `x-fake-mode` request header (forwarded through
// the gateway): "json" (default) or "sse". Both responses embed a mock email so
// outbound redaction has something to scrub.
const MOCK_PII_EMAIL = "mock.person@fake-leak.com";

export async function startFakeUpstream(): Promise<FakeUpstream> {
  const received: Received[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });

      const mode = String(req.headers["x-fake-mode"] ?? "json");
      if (mode === "sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // "reply from mock.person@fake-leak.com ok" split across chunks
        const send = (content: string) =>
          res.write(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`,
          );
        send("reply from mock.per");
        send("son@fake-le");
        send("ak.com ok");
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      const payload = JSON.stringify({
        id: "resp-1",
        reply: `sure — reach me at ${MOCK_PII_EMAIL} anytime`,
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload)),
      });
      res.end(payload);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    base: `http://127.0.0.1:${port}`,
    received,
    last: () => received[received.length - 1],
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

export { MOCK_PII_EMAIL };
