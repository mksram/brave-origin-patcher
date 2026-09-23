'use strict';
// Swap in the rebuilt split_chrome dex.
//
// Sibling of dexswap: same reasoning, different split. The settings, update and
// menu edits all live in the dex that owns Brave's settings fragments, so that
// class descriptor is what singles the split out.

const fs = require('fs');
const dex = require('../lib/dex');
const { register } = require('../lib/patches');

const ANCHOR = 'Lorg/chromium/chrome/browser/settings/BraveMainPreferencesBase;';
const MARKER = 'Google AI Mode';

const isDexEntry = (n) => /^classes\d*\.dex$/.test(n);
const hasAnchor = (buf) => dex.isDex(buf) && dex.strings(buf).includes(ANCHOR);

let cached = null;
function load(opts) {
  const p = opts && opts.dexChrome;
  if (!p) throw new Error('dexswap-chrome needs --dex-chrome <path to rebuilt classes.dex>');
  if (cached && cached.path === p) return cached.buf;
  const buf = fs.readFileSync(p);
  if (!dex.isDex(buf)) throw new Error('not a dex file: ' + p);
  if (!dex.verifyChecksums(buf)) throw new Error('dex checksums are stale: ' + p);
  const strings = dex.strings(buf);
  if (!strings.includes(ANCHOR)) throw new Error('replacement dex is not the settings dex: ' + p);
  if (!strings.includes(MARKER)) throw new Error('replacement dex carries no layer-2 patch: ' + p);
  cached = { path: p, buf };
  return buf;
}

module.exports = register({
  id: 'dexswap-chrome',
  description: 'Replace the settings/app-menu classes.dex with an externally rebuilt one (--dex-chrome)',
  targets: isDexEntry,

  probe(entryName, buf, ctx) {
    if (!hasAnchor(buf)) return { hits: 0 };
    if (!ctx.opts || !ctx.opts.dexChrome) {
      return { hits: 1, samples: ['anchor found, but no --dex-chrome given'] };
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
