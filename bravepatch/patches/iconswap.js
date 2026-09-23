'use strict';
// Replace one res/ entry's bytes with a prebuilt file.
//
// The quick-search row's icon comes from a drawable id hardcoded in the row
// binders, not from the row itself, so the only way to move the image without
// touching the keyword — the map key the enabled state and the row order are
// stored under — is to replace the drawable that id already resolves to.
//
// Both the entry name and the replacement come from the caller: the name is
// whatever aapt2 reports for the id settings-patch.js discovered, and that name
// changes with every release.

const fs = require('fs');
const { register } = require('../lib/patches');

let cached = null;
function load(opts) {
  const p = opts && opts.iconFile;
  if (!p) throw new Error('iconswap needs --icon-file <path to compiled drawable>');
  if (cached && cached.path === p) return cached.buf;
  const buf = fs.readFileSync(p);
  // Compiled binary XML: 0x0003 RES_XML_TYPE, 0x0008 header size.
  if (buf.length < 8 || buf.readUInt16LE(0) !== 0x0003) {
    throw new Error('not a compiled binary XML: ' + p);
  }
  cached = { path: p, buf };
  return buf;
}

module.exports = register({
  id: 'iconswap',
  description: "Replace a res/ entry with a prebuilt drawable (--icon-entry, --icon-file)",
  targets: (name, ctx) => !!(ctx && ctx.opts && ctx.opts.iconEntry) && name === ctx.opts.iconEntry,

  probe(entryName, buf, ctx) {
    const next = load(ctx.opts);
    return { hits: 1, samples: [`${entryName}: ${buf.length} -> ${next.length} bytes`] };
  },

  transform(entryName, buf, ctx) {
    const next = load(ctx.opts);
    return next.equals(buf) ? null : next;
  },
});
