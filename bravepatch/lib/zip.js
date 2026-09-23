'use strict';
const fs = require('fs');
const zlib = require('zlib');

const SIG_LFH = 0x04034b50;
const SIG_CDH = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;

const STORED = 0;
const DEFLATED = 8;

function findEOCD(fd, size) {
  const maxBack = Math.min(size, 0xffff + 22);
  const buf = Buffer.alloc(maxBack);
  fs.readSync(fd, buf, 0, maxBack, size - maxBack);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      return { offset: size - maxBack + i, buf: buf.subarray(i) };
    }
  }
  throw new Error('EOCD not found — not a zip?');
}

function open(path) {
  const fd = fs.openSync(path, 'r');
  const size = fs.fstatSync(fd).size;
  const { buf: eocd } = findEOCD(fd, size);

  const total = eocd.readUInt16LE(10);
  const cdSize = eocd.readUInt32LE(12);
  const cdOffset = eocd.readUInt32LE(16);

  if (cdOffset === 0xffffffff || total === 0xffff) {
    throw new Error('Zip64 archive — not supported');
  }

  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);

  const entries = [];
  let p = 0;
  for (let i = 0; i < total; i++) {
    if (cd.readUInt32LE(p) !== SIG_CDH) throw new Error('bad central directory at entry ' + i);
    const flags = cd.readUInt16LE(p + 8);
    // Streamed zips (the .apks container is one) set the data-descriptor flag and
    // zero the sizes in the local header. The central directory is still
    // authoritative, and write() clears the flag, so reading these is safe.
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const cmtLen = cd.readUInt16LE(p + 32);
    entries.push({
      name: cd.toString('utf8', p + 46, p + 46 + nameLen),
      versionMadeBy: cd.readUInt16LE(p + 4),
      versionNeeded: cd.readUInt16LE(p + 6),
      flags,
      method: cd.readUInt16LE(p + 10),
      modTime: cd.readUInt16LE(p + 12),
      modDate: cd.readUInt16LE(p + 14),
      crc32: cd.readUInt32LE(p + 16),
      compSize: cd.readUInt32LE(p + 20),
      uncompSize: cd.readUInt32LE(p + 24),
      internalAttr: cd.readUInt16LE(p + 36),
      externalAttr: cd.readUInt32LE(p + 38),
      localOff: cd.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + cmtLen;
  }

  return { fd, size, path, entries };
}

// Local header's name/extra lengths can differ from the central directory's,
// so the real data offset has to come from the local header itself.
function dataOffset(zip, e) {
  if (e._dataOff !== undefined) return e._dataOff;
  const h = Buffer.alloc(30);
  fs.readSync(zip.fd, h, 0, 30, e.localOff);
  if (h.readUInt32LE(0) !== SIG_LFH) throw new Error('bad local header: ' + e.name);
  e._dataOff = e.localOff + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  return e._dataOff;
}

function readRaw(zip, e) {
  const buf = Buffer.alloc(e.compSize);
  if (e.compSize) fs.readSync(zip.fd, buf, 0, e.compSize, dataOffset(zip, e));
  return buf;
}

function readData(zip, e) {
  const raw = readRaw(zip, e);
  if (e.method === STORED) return raw;
  if (e.method === DEFLATED) return zlib.inflateRawSync(raw);
  throw new Error('unsupported method ' + e.method + ': ' + e.name);
}

function close(zip) {
  fs.closeSync(zip.fd);
}

// Alignment of an entry's data offset, as observed in the source archive.
// Uncompressed entries are mmap'd straight out of the APK, so their alignment
// is load-bearing: libchrome.so needs page alignment or the loader rejects it.
function observedAlignment(zip, e) {
  if (e.method !== STORED) return 1;
  const off = dataOffset(zip, e);
  for (const a of [16384, 4096, 4]) if (off % a === 0) return a;
  return 1;
}

function defaultAlignment(name, method, soAlign) {
  if (method !== STORED) return 1;
  return name.endsWith('.so') ? soAlign : 4;
}

/**
 * items: [{ name, method, crc32, compSize, uncompSize, raw }]  (pre-compressed passthrough)
 *     or [{ name, data, compress? }]                            (fresh content)
 */
function write(outPath, items, opts = {}) {
  const soAlign = opts.soAlign || 16384;
  const fd = fs.openSync(outPath, 'w');
  let pos = 0;
  const written = [];

  const put = (buf) => { fs.writeSync(fd, buf, 0, buf.length, pos); pos += buf.length; };

  for (const it of items) {
    let { name, method, crc32, compSize, uncompSize, raw } = it;

    if (raw === undefined) {
      const data = it.data;
      if (it.compress) {
        raw = zlib.deflateRawSync(data, { level: 9 });
        method = DEFLATED;
      } else {
        raw = data;
        method = STORED;
      }
      crc32 = zlib.crc32(data);
      compSize = raw.length;
      uncompSize = data.length;
    }

    const nameBuf = Buffer.from(name, 'utf8');
    const align = it.align || defaultAlignment(name, method, soAlign);
    let padding = 0;
    if (align > 1) {
      const dataStart = pos + 30 + nameBuf.length;
      padding = (align - (dataStart % align)) % align;
    }

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(SIG_LFH, 0);
    lfh.writeUInt16LE(it.versionNeeded ?? 20, 4);
    lfh.writeUInt16LE((it.flags ?? 0) & ~0x8, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(it.modTime ?? 0, 10);
    lfh.writeUInt16LE(it.modDate ?? 0x0021, 12);
    lfh.writeUInt32LE(crc32 >>> 0, 14);
    lfh.writeUInt32LE(compSize, 18);
    lfh.writeUInt32LE(uncompSize, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(padding, 28);

    const localOff = pos;
    put(lfh);
    put(nameBuf);
    if (padding) put(Buffer.alloc(padding));
    put(raw);

    written.push({ ...it, name, method, crc32, compSize, uncompSize, localOff });
  }

  const cdStart = pos;
  for (const e of written) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(SIG_CDH, 0);
    cdh.writeUInt16LE(e.versionMadeBy ?? 20, 4);
    cdh.writeUInt16LE(e.versionNeeded ?? 20, 6);
    cdh.writeUInt16LE((e.flags ?? 0) & ~0x8, 8);
    cdh.writeUInt16LE(e.method, 10);
    cdh.writeUInt16LE(e.modTime ?? 0, 12);
    cdh.writeUInt16LE(e.modDate ?? 0x0021, 14);
    cdh.writeUInt32LE(e.crc32 >>> 0, 16);
    cdh.writeUInt32LE(e.compSize, 20);
    cdh.writeUInt32LE(e.uncompSize, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(e.externalAttr ?? 0, 38);
    cdh.writeUInt32LE(e.localOff, 42);
    put(cdh);
    put(nameBuf);
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(written.length, 8);
  eocd.writeUInt16LE(written.length, 10);
  eocd.writeUInt32LE(pos - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  put(eocd);

  fs.closeSync(fd);
  return written;
}

module.exports = {
  open, close, readRaw, readData, dataOffset, write,
  observedAlignment, STORED, DEFLATED,
};
