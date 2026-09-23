'use strict';
// Round-trip an APK through the rewriter and prove nothing shifted.
// Raw passthrough must reproduce every entry byte-for-byte and keep the
// alignment of STORED entries, since those are mmap'd in place at runtime.
const fs = require('fs');
const zip = require('./lib/zip');

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node roundtrip.js <in.apk> <out.apk>');
  process.exit(1);
}

const src = zip.open(inPath);
console.log(`in : ${inPath}  (${src.entries.length} entries, ${src.size} bytes)`);

const before = src.entries.map((e) => ({
  name: e.name,
  method: e.method,
  crc32: e.crc32,
  compSize: e.compSize,
  uncompSize: e.uncompSize,
  align: zip.observedAlignment(src, e),
}));

const soAlign = Math.max(
  16384,
  ...before.filter((e) => e.name.endsWith('.so')).map((e) => e.align)
);

const items = src.entries.map((e) => ({
  name: e.name,
  method: e.method,
  crc32: e.crc32,
  compSize: e.compSize,
  uncompSize: e.uncompSize,
  raw: zip.readRaw(src, e),
  flags: e.flags,
  modTime: e.modTime,
  modDate: e.modDate,
  versionMadeBy: e.versionMadeBy,
  versionNeeded: e.versionNeeded,
  externalAttr: e.externalAttr,
}));

zip.write(outPath, items, { soAlign });
zip.close(src);

const dst = zip.open(outPath);
console.log(`out: ${outPath}  (${dst.entries.length} entries, ${dst.size} bytes)`);

let bad = 0;
const fail = (msg) => { console.log('  FAIL ' + msg); bad++; };

if (dst.entries.length !== before.length) fail(`entry count ${dst.entries.length} != ${before.length}`);

for (let i = 0; i < Math.min(before.length, dst.entries.length); i++) {
  const a = before[i];
  const b = dst.entries[i];
  if (a.name !== b.name) fail(`[${i}] name ${b.name} != ${a.name}`);
  if (a.method !== b.method) fail(`${a.name}: method ${b.method} != ${a.method}`);
  if (a.crc32 !== b.crc32) fail(`${a.name}: crc ${b.crc32} != ${a.crc32}`);
  if (a.compSize !== b.compSize) fail(`${a.name}: compSize ${b.compSize} != ${a.compSize}`);
  if (a.uncompSize !== b.uncompSize) fail(`${a.name}: uncompSize ${b.uncompSize} != ${a.uncompSize}`);
  const alignAfter = zip.observedAlignment(dst, b);
  if (a.method === zip.STORED && alignAfter < a.align) {
    fail(`${a.name}: alignment dropped ${a.align} -> ${alignAfter}`);
  }
}

for (const e of dst.entries.filter((x) => x.method === zip.STORED)) {
  console.log(`  stored: ${e.name}  align=${zip.observedAlignment(dst, e)}  off=${zip.dataOffset(dst, e)}`);
}
zip.close(dst);

console.log(bad === 0 ? '\nROUND-TRIP OK' : `\n${bad} PROBLEM(S)`);
process.exit(bad === 0 ? 0 : 1);
