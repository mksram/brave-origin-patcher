'use strict';
// Byte-level patch registry.
//
// Every patch locates its target by an *anchor* — a literal string that is part
// of a public API (policy names, provider authorities, resource names) and so
// survives both version bumps and R8 obfuscation. Nothing here may depend on a
// byte offset or an obfuscated class name, or it will rot on the next release.

const patches = [];

function register(p) {
  patches.push(p);
  return p;
}

function get(ids) {
  if (!ids) return patches.slice();
  const byId = new Map(patches.map((p) => [p.id, p]));
  return ids.map((id) => {
    const p = byId.get(id);
    if (!p) throw new Error(`unknown patch: ${id} (have: ${patches.map((x) => x.id).join(', ')})`);
    return p;
  });
}

module.exports = { register, get, all: patches };

// Loaded last: each patch module requires this one back to self-register.
// Order is the order they run on a shared buffer, so the dex must be swapped
// before anything that rewrites strings inside it.
require('../patches/dexswap');
require('../patches/dexswap-chrome');
require('../patches/pkgrename');
require('../patches/iconswap');
