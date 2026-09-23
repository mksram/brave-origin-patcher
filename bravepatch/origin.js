#!/usr/bin/env node
'use strict';
// One command from a stock Brave bundle to a patched, signed, side-by-side build.
//
//   node origin.js <Brave.apks> -o <outdir>
//
// Two splits need new bytecode: the base split owns PolicyProvider and the
// preference store, the chrome split owns the settings fragments and the app
// menu. apktool is the slow part, and it does not need to see a 253 MB APK to
// reassemble one dex, so each split's manifest and dex are carved into a
// throwaway mini APK first: that takes apktool from minutes to ~30 s per split,
// and the 219 MB libchrome.so never gets touched, re-compressed or re-aligned.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const zip = require('./lib/zip');

const ROOT = __dirname;
const ANCHOR = '#notifySettingsAvailable() ';
const SETTINGS_ANCHOR = 'Lorg/chromium/chrome/browser/settings/BraveMainPreferencesBase;';
const dex = require('./lib/dex');

function die(msg) {
  console.error('error: ' + msg);
  process.exit(1);
}

function step(n, msg) {
  console.log(`\n[${n}] ${msg}`);
}

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const text = (err.stderr || err.stdout || Buffer.alloc(0)).toString('utf8').trim();
    die(`${cmd} ${args.join(' ')}\n${text}`);
  }
}

// Every split carries a classes.dex, so each one is identified by a string only
// the dex we want can contain.
function splitsByAnchor(apksPath, workDir, anchors) {
  const outer = zip.open(apksPath);
  const found = {};
  for (const e of outer.entries) {
    if (!e.name.endsWith('.apk')) continue;
    const dest = path.join(workDir, path.basename(e.name));
    fs.writeFileSync(dest, zip.readData(outer, e));
    const z = zip.open(dest);
    const entry = z.entries.find((x) => /^classes\d*\.dex$/.test(x.name));
    const strings = entry ? dex.strings(zip.readData(z, entry)) : [];
    zip.close(z);
    let keep = false;
    for (const [key, anchor] of Object.entries(anchors)) {
      if (!found[key] && strings.includes(anchor)) {
        found[key] = dest;
        keep = true;
      }
    }
    if (!keep) fs.unlinkSync(dest);
  }
  zip.close(outer);
  return found;
}

function carveMini(splitPath, miniPath) {
  const z = zip.open(splitPath);
  const keep = ['AndroidManifest.xml', 'classes.dex'];
  const items = keep.map((name) => {
    const e = z.entries.find((x) => x.name === name) || die('split has no ' + name);
    return { name, data: zip.readData(z, e), compress: false };
  });
  zip.write(miniPath, items, {});
  zip.close(z);
}

// Resource *entry* names survive R8, so the numeric id can be looked up instead
// of pinned. aapt2 is already a hard dependency via apktool.
function resourceId(apkPath, entry) {
  let out;
  try {
    out = execFileSync('sh', ['-c', 'aapt2 dump resources "$0" | grep -m1 -- "$1"', apkPath, ' id/' + entry], {
      encoding: 'utf8',
      maxBuffer: 1 << 20,
    });
  } catch {
    die(`aapt2 found no id/${entry} in ${path.basename(apkPath)}`);
  }
  const m = /resource\s+(0x[0-9a-f]+)\s+id\//.exec(out);
  return m ? m[1] : die(`could not parse the id of ${entry}`);
}

// The quick-search row's icon is a hardcoded drawable id, and the drawable's own
// entry name is obfuscated to something like res/D4Y.xml that changes every
// release, so the id has to be resolved back to a file name.
function resourceFile(apkPath, id) {
  let out;
  try {
    out = execFileSync('sh', ['-c', 'aapt2 dump resources "$0" | grep -m1 -A1 -- "$1"', apkPath, 'resource ' + id + ' '], {
      encoding: 'utf8',
      maxBuffer: 1 << 20,
    });
  } catch {
    die(`aapt2 found no resource ${id} in ${path.basename(apkPath)}`);
  }
  const m = /\(file\)\s+(\S+)/.exec(out);
  return m ? m[1] : die(`resource ${id} is not backed by a file:\n${out.trim()}`);
}

// carve -> decode -> inject -> rebuild -> hand back just the dex
function roundTrip(splitPath, work, tag, injectors) {
  const mini = path.join(work, tag + '-mini.apk');
  carveMini(splitPath, mini);
  console.log(`    ${tag}: ${(fs.statSync(mini).size / 1e6).toFixed(1)} MB carved`);

  const decoded = path.join(work, tag + '-decoded');
  run('apktool', ['d', '-f', '-r', '-o', decoded, mini]);

  for (const [script, extra] of injectors) {
    execFileSync('node', [path.join(ROOT, script), decoded, ...extra], { stdio: 'inherit' });
  }

  const rebuilt = path.join(work, tag + '-rebuilt.apk');
  run('apktool', ['b', '-f', '-o', rebuilt, decoded]);

  const rz = zip.open(rebuilt);
  const re = rz.entries.find((x) => x.name === 'classes.dex') || die(tag + ' rebuild produced no dex');
  const out = path.join(work, tag + '-classes.dex');
  fs.writeFileSync(out, zip.readData(rz, re));
  zip.close(rz);
  console.log(`    ${tag}: ${fs.statSync(out).size} bytes`);
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const input = argv.find((a) => !a.startsWith('-')) || die('usage: origin.js <Brave.apks> -o <outdir>');
  const oi = argv.indexOf('-o');
  const outDir = oi >= 0 ? argv[oi + 1] : path.join(ROOT, 'out');
  const pkgIdx = argv.indexOf('--pkg');
  const pkg = pkgIdx >= 0 ? argv[pkgIdx + 1] : 'com.brave.origins';

  const work = fs.mkdtempSync(path.join(process.env.HOME, 'origin-'));
  try {
    step(1, 'locating the two splits that need patching');
    const splits = splitsByAnchor(input, work, { base: ANCHOR, chrome: SETTINGS_ANCHOR });
    if (!splits.base) die('no split carries the ' + ANCHOR + ' anchor');
    if (!splits.chrome) die('no split carries the ' + SETTINGS_ANCHOR + ' anchor');
    console.log('    base  : ' + path.basename(splits.base));
    console.log('    chrome: ' + path.basename(splits.chrome));

    step(2, 'resolving the managed-browser menu id from resources');
    const menuId = resourceId(splits.base, 'managed_by_menu_id');
    console.log('    managed_by_menu_id = ' + menuId);

    step(3, 'base split: policies + seeded preferences');
    const baseDex = roundTrip(splits.base, work, 'base', [
      ['policy-inject.js', []],
      ['prefs-seed.js', []],
    ]);

    step(4, 'chrome split: hidden rows, update check, app menu, quick search');
    const iconIdFile = path.join(work, 'icon-id.txt');
    const chromeDex = roundTrip(splits.chrome, work, 'chrome', [
      ['settings-patch.js', ['--menu-id', menuId, '--emit-icon-id', iconIdFile]],
    ]);

    step(5, 'quick-search icon: replacing the drawable that id points at');
    const iconId = fs.readFileSync(iconIdFile, 'utf8').trim();
    const iconEntry = resourceFile(splits.base, iconId);
    console.log(`    ${iconId} -> ${iconEntry}`);
    const iconFile = path.join(work, 'qse-icon.xml');
    execFileSync('node', [path.join(ROOT, 'icon-build.js'), '-o', iconFile], { stdio: 'inherit' });

    step(6, 'bravepatch build (dexswap x2 + pkgrename + iconswap), sign');
    execFileSync(
      'node',
      [
        path.join(ROOT, 'bravepatch.js'), 'build', input,
        '-o', outDir,
        '--dex', baseDex,
        '--dex-chrome', chromeDex,
        '--icon-entry', iconEntry,
        '--icon-file', iconFile,
        '--pkg', pkg,
      ],
      { stdio: 'inherit' }
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main();
