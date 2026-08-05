// ===== ZIP reader/writer (zero dependency) ==================================
// DOCX/XLSX/PPTX are ZIP archives of XML, so reading and rewriting them needs a
// ZIP implementation. `CompressionStream`/`DecompressionStream` are built into
// both browsers and Node, which leaves only the container format to handle here
// — no library, consistent with the project's zero-dependency rule.
//
// Deliberately minimal: no encryption, no ZIP64, no multi-disk. Office files
// written by Office/LibreOffice/Google are plain single-disk deflate archives.
// Anything outside that surfaces as a thrown error, which the upload guard turns
// into a BLOCK — never into a silent pass.

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

// --- CRC-32 -----------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** Standard CRC-32 (the ZIP variant). */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- stream helpers ---------------------------------------------------------
async function through(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const inflateRaw = (bytes) => through(bytes, new DecompressionStream("deflate-raw"));
const deflateRaw = (bytes) => through(bytes, new CompressionStream("deflate-raw"));

const utf8 = new TextEncoder();

// --- reading ----------------------------------------------------------------
/**
 * Read every entry of a ZIP archive, in CENTRAL DIRECTORY order.
 *
 * The central directory (not the local headers) is authoritative for sizes, so
 * entries written with a streaming data descriptor read correctly too.
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {Promise<Array<{name: string, data: Uint8Array}>>}
 */
export async function readZip(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // The EOCD sits at the end, after an optional comment — scan backwards.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory record)");

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = [];
  const decoder = new TextDecoder();

  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== CENTRAL_SIG) throw new Error("corrupt central directory");
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));

    if (view.getUint32(localOff, true) !== LOCAL_SIG) throw new Error(`corrupt local header for ${name}`);
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);

    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`unsupported compression method ${method} for ${name}`);
    if (usize && data.length !== usize) throw new Error(`size mismatch for ${name}`);

    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// --- writing ----------------------------------------------------------------
/**
 * Write entries to a ZIP archive, PRESERVING the given order — OPC readers
 * expect `[Content_Types].xml` first, so callers pass entries back in the order
 * `readZip` returned them.
 *
 * @param {Array<{name: string, data: Uint8Array, compress?: boolean}>} entries
 * @returns {Promise<Uint8Array>}
 */
export async function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = utf8.encode(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const wantDeflate = entry.compress !== false && data.length > 0;
    let body = data;
    let method = 0;
    if (wantDeflate) {
      const deflated = await deflateRaw(data);
      // Only keep the compressed form if it actually helped.
      if (deflated.length < data.length) {
        body = deflated;
        method = 8;
      }
    }
    const sum = crc32(data);

    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0x21, true); // mod date (1980-01-01: deterministic output)
    lv.setUint32(14, sum, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_SIG, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, sum, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const l of locals) {
    out.set(l, at);
    at += l.length;
  }
  for (const c of centrals) {
    out.set(c, at);
    at += c.length;
  }
  out.set(eocd, at);
  return out;
}
