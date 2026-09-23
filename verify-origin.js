#!/usr/bin/env node
'use strict';
// Static checks on a built Brave Origin output directory: every policy name and
// every seeded preference key must survive into the shipped dex, the manifest
// must carry the renamed package, and the native library must stay stored and
// 16 KB aligned.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const zip = require('./bravepatch/lib/zip');
const dex = require('./bravepatch/lib/dex');

const outDir = process.argv[2] || '/sdcard/Download/brave-origin-out';
const pkg = process.argv[3] || 'com.brave.origins';

const policySrc = fs.readFileSync(path.join(__dirname, 'bravepatch/policy-inject.js'), 'utf8');
const seedSrc = fs.readFileSync(path.join(__dirname, 'bravepatch/prefs-seed.js'), 'utf8');
const layer2Src = fs.readFileSync(path.join(__dirname, 'bravepatch/settings-patch.js'), 'utf8');
const iconSrc = require('./bravepatch/icon-build');

const ENTRY = /^\s{2}(\w+):\s*(?:true|false|-?\d+|NEVER),\s*(?:\/\/.*)?$/gm;

const POLICIES = [...policySrc.matchAll(ENTRY)].map((m) => m[1]);
const SEEDED = [...seedSrc.matchAll(ENTRY)].map((m) => m[1]);
const MENU = SEEDED.filter((k) => k.endsWith('_id'));
const KEYS = SEEDED.filter((k) => !k.endsWith('_id')).map((k) =>
  k.startsWith('Chrome_') ? k.split('_').reduce((a, p, i) => (i === 0 ? p : a + '.' + p)) : k
);
const qse = (name) => new RegExp(`^const ${name} = '(.+)';$`, 'm').exec(layer2Src)[1];

let fail = 0;
const check = (ok, label, detail = '') => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
};

const base = path.join(outDir, 'Brave.apk');
const z = zip.open(base);

console.log('base dex strings');
const dexEntry = z.entries.find((e) => e.name === 'classes.dex');
const strings = new Set(dex.strings(zip.readData(z, dexEntry)));
const missingPolicies = POLICIES.filter((p) => !strings.has(p));
check(!missingPolicies.length, `${POLICIES.length} policy names`, missingPolicies.join(','));
const missingKeys = KEYS.filter((k) => !strings.has(k));
check(!missingKeys.length, `${KEYS.length} seeded keys`, missingKeys.join(','));
const missingMenu = MENU.filter((m) => !strings.has('customizable_brave_menu_item_id_' + m));
check(!missingMenu.length, `${MENU.length} menu item keys`, missingMenu.join(','));
check(strings.has('bravepatch.seeded_v1'), 'seed marker key');

console.log('quick-search icon');
// The drawable's entry name is obfuscated and changes every release, so the
// swap is confirmed by content: aapt2 keeps pathData as a UTF-8 string, so the
// replaced entry is the only res/ XML carrying the Google mark's first path.
const GOOGLE_PATH = Buffer.from(/android:pathData="([^"]{24})/.exec(iconSrc.VECTOR)[1], 'utf8');
const iconEntry = z.entries
  .filter((e) => /^res\/.*\.xml$/.test(e.name))
  .find((e) => zip.readData(z, e).includes(GOOGLE_PATH));
check(!!iconEntry, 'Google mark swapped in', iconEntry ? iconEntry.name : '');

console.log('native library');const so = z.entries.find((e) => e.name.endsWith('libchrome.so'));
check(!!so, 'libchrome.so present');
if (so) {
  check(so.method === zip.STORED, 'stored (uncompressed)', 'method=' + so.method);
  const align = zip.observedAlignment(z, so);
  check(align === 16384, '16384-byte aligned', 'align=' + align);
}
zip.close(z);

console.log('chrome dex strings');
const cz = zip.open(path.join(outDir, 'split_chrome.apk'));
const cDex = cz.entries.find((e) => e.name === 'classes.dex');
const cStrings = new Set(dex.strings(zip.readData(cz, cDex)));
zip.close(cz);
check(cStrings.has(qse('QSE_NAME')), 'quick search engine renamed', qse('QSE_NAME'));
check(cStrings.has(qse('QSE_URL')), 'quick search engine retargeted');

console.log('manifest + signature');
for (const name of fs.readdirSync(outDir).filter((f) => f.endsWith('.apk'))) {
  const az = zip.open(path.join(outDir, name));
  for (const e of az.entries.filter((x) => x.name === 'AndroidManifest.xml')) {
    const raw = zip.readData(az, e);
    const utf16 = (s) => Buffer.from(s, 'utf16le');
    check(raw.includes(utf16('com.brave.browser')) === false, name + ': old package absent');
    check(raw.includes(utf16(pkg)), name + ': new package present', pkg);
  }
  zip.close(az);
  let signed = true;
  try {
    execFileSync('apksigner', ['verify', '--min-sdk-version', '29', path.join(outDir, name)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    signed = false;
  }
  check(signed, name + ': signature verifies');
}

console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
