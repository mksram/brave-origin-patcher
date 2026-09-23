'use strict';
const crypto = require('crypto');

const MAGIC = Buffer.from('dex\n');

// Header layout we care about:
//   [8 ..12)  adler32 over everything from offset 12 onward
//   [12..32)  sha1 over everything from offset 32 onward
//   [56..60)  string_ids_size
//   [60..64)  string_ids_off
const OFF_CHECKSUM = 8;
const OFF_SIGNATURE = 12;
const OFF_STRING_IDS_SIZE = 56;
const OFF_STRING_IDS_OFF = 60;

function isDex(buf) {
  return buf.length > 64 && buf.subarray(0, 4).equals(MAGIC);
}

function adler32(buf) {
  const MOD = 65521;
  const NMAX = 5552; // largest block that cannot overflow the accumulators
  let a = 1;
  let b = 0;
  let i = 0;
  let len = buf.length;
  while (len > 0) {
    let n = Math.min(NMAX, len);
    len -= n;
    while (n--) {
      a += buf[i++];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

// Any edit to dex bytes invalidates both integrity fields; the verifier rejects
// the file at install time if they are stale. Signature first — checksum covers it.
function fixChecksums(buf) {
  const sha1 = crypto.createHash('sha1').update(buf.subarray(32)).digest();
  sha1.copy(buf, OFF_SIGNATURE);
  buf.writeUInt32LE(adler32(buf.subarray(12)), OFF_CHECKSUM);
  return buf;
}

function verifyChecksums(buf) {
  const sha1 = crypto.createHash('sha1').update(buf.subarray(32)).digest();
  return (
    sha1.equals(buf.subarray(OFF_SIGNATURE, OFF_SIGNATURE + 20)) &&
    adler32(buf.subarray(12)) === buf.readUInt32LE(OFF_CHECKSUM)
  );
}

function readUleb128(buf, p) {
  let shift = 0;
  let val = 0;
  let b;
  do {
    b = buf[p++];
    val |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return { val, next: p };
}

// Returns { str, start, end } per entry — start/end bound the MUTF-8 bytes only,
// excluding the ULEB128 length prefix and the trailing NUL.
function stringItems(buf) {
  const count = buf.readUInt32LE(OFF_STRING_IDS_SIZE);
  const table = buf.readUInt32LE(OFF_STRING_IDS_OFF);
  const out = [];
  for (let i = 0; i < count; i++) {
    const { next: start } = readUleb128(buf, buf.readUInt32LE(table + i * 4));
    let end = start;
    while (buf[end] !== 0) end++;
    out.push({ str: buf.toString('utf8', start, end), start, end });
  }
  return out;
}

function strings(buf) {
  return stringItems(buf).map((s) => s.str);
}

/**
 * Rewrite string-table entries in place. `fn(str)` returns a replacement or null.
 * Only equal-byte-length replacements are allowed: the ULEB128 length prefix and
 * every string_ids offset stay valid, so no section needs relocating.
 */
function replaceStrings(buf, fn) {
  let changed = 0;
  for (const item of stringItems(buf)) {
    const next = fn(item.str);
    if (next == null || next === item.str) continue;
    const bytes = Buffer.from(next, 'utf8');
    if (bytes.length !== item.end - item.start) {
      throw new Error(
        `dex string replacement must keep byte length: "${item.str}" (${item.end - item.start}) -> "${next}" (${bytes.length})`
      );
    }
    bytes.copy(buf, item.start);
    changed++;
  }
  if (changed) fixChecksums(buf);
  return changed;
}

module.exports = {
  isDex, adler32, fixChecksums, verifyChecksums,
  strings, stringItems, replaceStrings,
};
