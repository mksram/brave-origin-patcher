'use strict';
const dex = require('../lib/dex');
const { register } = require('../lib/patches');

const DEFAULT_FROM = 'com.brave.browser';
const DEFAULT_TO = 'com.brave.origins';

const isManifest = (n) => n === 'AndroidManifest.xml';
const isArsc = (n) => n === 'resources.arsc';
const isDexEntry = (n) => /^classes\d*\.dex$/.test(n);
const targets = (n) => isManifest(n) || isArsc(n) || isDexEntry(n);

// AXML and ARSC keep their strings in length-prefixed pools. Replacing a run of
// bytes with the same number of bytes leaves every pool offset and every chunk
// size untouched, which is why the rename is constrained to equal-length names.
function replaceSameLength(buf, from, to, encoding) {
  const a = Buffer.from(from, encoding);
  const b = Buffer.from(to, encoding);
  if (a.length !== b.length) throw new Error('internal: unequal encoded lengths');
  let count = 0;
  let i = 0;
  while ((i = buf.indexOf(a, i)) >= 0) {
    b.copy(buf, i);
    i += b.length;
    count++;
  }
  return count;
}

function countOccurrences(buf, needle, encoding) {
  const a = Buffer.from(needle, encoding);
  let count = 0;
  let i = 0;
  while ((i = buf.indexOf(a, i)) >= 0) {
    i += a.length;
    count++;
  }
  return count;
}

function names(opts = {}) {
  const from = opts.from || DEFAULT_FROM;
  const to = opts.to || DEFAULT_TO;
  if (Buffer.byteLength(from, 'utf8') !== Buffer.byteLength(to, 'utf8')) {
    throw new Error(
      `package rename must keep the same length: "${from}" (${from.length}) vs "${to}" (${to.length})`
    );
  }
  return { from, to };
}

module.exports = register({
  id: 'pkgrename',
  description: 'Rename applicationId so the patched build installs alongside the original',
  targets,

  probe(entryName, buf, ctx) {
    const { from } = names(ctx.opts);
    if (dex.isDex(buf)) {
      const hits = dex.strings(buf).filter((s) => s.includes(from));
      return { hits: hits.length, samples: hits.slice(0, 8) };
    }
    const u16 = countOccurrences(buf, from, 'utf16le');
    const u8 = countOccurrences(buf, from, 'utf8');
    return { hits: u16 + u8, samples: [`utf16:${u16}`, `utf8:${u8}`] };
  },

  transform(entryName, buf, ctx) {
    const { from, to } = names(ctx.opts);

    if (dex.isDex(buf)) {
      const changed = dex.replaceStrings(buf, (s) => (s.includes(from) ? s.split(from).join(to) : null));
      if (changed && !dex.verifyChecksums(buf)) throw new Error('dex checksum fix failed');
      return changed ? buf : null;
    }

    // Manifest string pools are UTF-16; the arsc package-name field is a fixed
    // UTF-16 array. Try UTF-8 too so an aapt2 build that chose it still works.
    const changed =
      replaceSameLength(buf, from, to, 'utf16le') + replaceSameLength(buf, from, to, 'utf8');
    return changed ? buf : null;
  },
});
