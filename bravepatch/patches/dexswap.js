'use strict';
// Swap in a classes.dex that was rebuilt out of band.
//
// Adding instructions to a method body means growing its code item and
// relocating everything after it, which is a dex assembler's job — so the
// policy injection runs through apktool (decode -> policy-inject.js -> build)
// and lands here as a finished dex. Everything else in the APK is still
// passed through byte-for-byte by the zip rewriter.
//
// Three splits ship a classes.dex, so the entry name alone does not identify
// the right one. The dex that owns PolicyProvider is singled out by the same
// log literal the smali patch anchors on.

const fs = require('fs');
const dex = require('../lib/dex');
const { register } = require('../lib/patches');

const ANCHOR = '#notifySettingsAvailable() ';
const POLICY_MARKER = 'BraveRewardsDisabled';

const isDexEntry = (n) => /^classes\d*\.dex$/.test(n);
const hasAnchor = (buf) => dex.isDex(buf) && dex.strings(buf).includes(ANCHOR);

let cached = null;
function load(opts) {
  const p = opts && opts.dex;
  if (!p) throw new Error('dexswap needs --dex <path to rebuilt classes.dex>');
  if (cached && cached.path === p) return cached.buf;
  const buf = fs.readFileSync(p);
  if (!dex.isDex(buf)) throw new Error('not a dex file: ' + p);
  if (!dex.verifyChecksums(buf)) throw new Error('dex checksums are stale: ' + p);
  const strings = dex.strings(buf);
  if (!strings.includes(ANCHOR)) throw new Error('replacement dex is not the PolicyProvider dex: ' + p);
  if (!strings.includes(POLICY_MARKER)) throw new Error('replacement dex carries no injected policy: ' + p);
  cached = { path: p, buf };
  return buf;
}

module.exports = register({
  id: 'dexswap',
  description: 'Replace the PolicyProvider classes.dex with an externally rebuilt one (--dex)',
  targets: isDexEntry,

  probe(entryName, buf, ctx) {
    if (!hasAnchor(buf)) return { hits: 0 };
    if (!ctx.opts || !ctx.opts.dex) {
      return { hits: 1, samples: ['anchor found, but no --dex given'] };
    }
    const next = load(ctx.opts);
    return { hits: 1, samples: [`${buf.length} -> ${next.length} bytes`] };
  },

  transform(entryName, buf, ctx) {
    if (!hasAnchor(buf)) return null;
    const next = load(ctx.opts);
    return next.equals(buf) ? null : next;
  },
});
