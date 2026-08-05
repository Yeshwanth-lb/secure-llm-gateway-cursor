// ===== ADMIN AUTH (Phase U) — zero-dep password + JWT ========================
// Passwords: scrypt (node:crypto) with a per-user random salt — no bcrypt.
// Sessions: HS256 JWT built with crypto.createHmac — no jsonwebtoken lib.
// Login rate-limit: in-memory sliding window, 5/min/IP.
//
// The signing secret is `config.adminToken` when set, else a random key persisted
// next to the admin DB (0600) so tokens survive a restart. In-memory/test DBs get
// a per-process random secret (stable for the life of the process).

import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const SCRYPT_KEYLEN = 64;

/** `scrypt$<saltHex>$<hashHex>` — self-describing so a later param bump is easy. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split("$");
    if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// --- JWT (HS256) ------------------------------------------------------------
const b64url = (buf: Buffer | string) =>
  (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString("base64url");

export function signJWT(payload: Record<string, unknown>, secret: string, ttlSeconds = 8 * 60 * 60): string {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify(body));
  const sig = createHmac("sha256", secret).update(`${header}.${claims}`).digest("base64url");
  return `${header}.${claims}.${sig}`;
}

/** Verify signature + expiry. Returns the payload, or null if invalid/expired. */
export function verifyJWT(token: string, secret: string): Record<string, any> | null {
  try {
    const parts = String(token).split(".");
    if (parts.length !== 3) return null;
    const [header, claims, sig] = parts;
    const expected = createHmac("sha256", secret).update(`${header}.${claims}`).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
    if (typeof payload.exp === "number" && Math.floor(Date.now() / 1000) >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// --- signing secret ---------------------------------------------------------
let memorySecret = "";
export function jwtSecret(config: { adminToken: string; adminDbPath: string }): string {
  if (config.adminToken && config.adminToken.length >= 8) return config.adminToken;
  if (config.adminDbPath === ":memory:") {
    if (!memorySecret) memorySecret = randomBytes(32).toString("hex");
    return memorySecret;
  }
  const keyPath = join(dirname(config.adminDbPath), "jwt.key");
  try {
    return readFileSync(keyPath, "utf8").trim();
  } catch {
    const secret = randomBytes(32).toString("hex");
    try {
      mkdirSync(dirname(keyPath), { recursive: true });
      writeFileSync(keyPath, secret, { mode: 0o600 });
    } catch {
      /* fall back to in-memory if the FS is read-only */
      if (!memorySecret) memorySecret = secret;
      return memorySecret;
    }
    return secret;
  }
}

// --- Bearer extraction ------------------------------------------------------
export function bearerToken(req: { headers: Record<string, any> }): string {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

/** Returns the auth payload if the request carries a valid admin JWT, else null. */
export function authFromRequest(req: { headers: Record<string, any> }, secret: string): Record<string, any> | null {
  const tok = bearerToken(req);
  return tok ? verifyJWT(tok, secret) : null;
}

// --- login rate limit (5 / minute / IP) -------------------------------------
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;
const attempts = new Map<string, number[]>();

/** True if this IP may attempt a login now; records the attempt. */
export function allowLoginAttempt(ip: string, nowFn: () => number = Date.now): boolean {
  const now = nowFn();
  const list = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_ATTEMPTS) {
    attempts.set(ip, list);
    return false;
  }
  list.push(now);
  attempts.set(ip, list);
  return true;
}

/** Test hook: clear the rate-limit state. */
export function resetLoginRate(): void {
  attempts.clear();
}
