#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const zip = require('./lib/zip');
const registry = require('./lib/patches');

const ROOT = __dirname;
const KEYSTORE = path.join(ROOT, 'bravepatch.keystore');
const KS_PASS = 'pass:bravepatch';
const KS_ALIAS = 'bravepatch';

// Play's source stamp is bound to the original signing cert, so it can only
// ever fail once we re-sign. Drop it rather than ship a stamp that cannot verify.
const DROP_ENTRIES = new Set(['stamp-cert-sha256']);

function die(msg) {
  console.error('error: ' + msg);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { patches: null, pkg: null, out: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') opts.out = argv[++i];
    else if (a === '--patch') opts.patches = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--pkg') opts.pkg = argv[++i];
    else if (a === '--dex') opts.dex = argv[++i];
    else if (a === '--dex-chrome') opts.dexChrome = argv[++i];
    else if (a === '--icon-entry') opts.iconEntry = argv[++i];
    else if (a === '--icon-file') opts.iconFile = argv[++i];
    else if (a.startsWith('-')) die('unknown flag ' + a);
    else rest.push(a);
  }
  return { opts, rest };
}

function unpackApks(apksPath, workDir) {
  const outer = zip.open(apksPath);
  const splits = [];
  for (const e of outer.entries) {
    if (!e.name.endsWith('.apk')) continue;
    const dest = path.join(workDir, path.basename(e.name));
    fs.writeFileSync(dest, zip.readData(outer, e));
    splits.push(dest);
  }
  zip.close(outer);
  if (!splits.length) die('no .apk entries inside ' + apksPath);
  return splits;
}

function splitsFrom(input, workDir) {
  if (input.endsWith('.apks') || input.endsWith('.xapk') || input.endsWith('.apkm')) {
    return unpackApks(input, workDir);
  }
  if (input.endsWith('.apk')) {
    const dest = path.join(workDir, path.basename(input));
    fs.copyFileSync(input, dest);
    return [dest];
  }
  die('expected .apks or .apk, got ' + input);
}

function cmdProbe(input, opts) {
  const workDir = fs.mkdtempSync(path.join(process.env.HOME, 'bravepatch-probe-'));
  try {
    const splits = splitsFrom(input, workDir);
    const selected = registry.get(opts.patches);
    console.log(`input   : ${input}`);
    console.log(`splits  : ${splits.map((s) => path.basename(s)).join(', ')}\n`);

    let totalHits = 0;
    for (const patch of selected) {
      console.log(`patch ${patch.id} — ${patch.description}`);
      let hits = 0;
      for (const splitPath of splits) {
        const z = zip.open(splitPath);
        for (const e of z.entries) {
          if (!patch.targets(e.name, { opts })) continue;
          const res = patch.probe(e.name, zip.readData(z, e), { opts, split: path.basename(splitPath) });
          if (res && res.hits) {
            hits += res.hits;
            console.log(`   ${path.basename(splitPath)}/${e.name}: ${res.hits} hit(s)  ${(res.samples || []).join(' ')}`);
          }
        }
        zip.close(z);
      }
      console.log(hits ? `   => ANCHOR OK (${hits} total)\n` : '   => ANCHOR MISSING — patch would be a no-op\n');
      totalHits += hits;
    }
    process.exit(totalHits > 0 ? 0 : 1);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function sign(apkPath) {
  execFileSync('apksigner', [
    'sign',
    '--ks', KEYSTORE,
    '--ks-pass', KS_PASS,
    '--key-pass', KS_PASS,
    '--ks-key-alias', KS_ALIAS,
    // v1 would inject META-INF entries and re-lay the zip, undoing our alignment.
    '--v1-signing-enabled', 'false',
    '--v2-signing-enabled', 'true',
    '--v3-signing-enabled', 'true',
    // v4 only emits a side-car .idsig for incremental install, which we never use.
    '--v4-signing-enabled', 'false',
    apkPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function cmdBuild(input, opts) {
  const outDir = opts.out || path.join(ROOT, 'out');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const workDir = fs.mkdtempSync(path.join(process.env.HOME, 'bravepatch-build-'));
  try {
    const splits = splitsFrom(input, workDir);
    const selected = registry.get(opts.patches);
    console.log(`patches : ${selected.map((p) => p.id).join(', ') || '(none)'}`);

    for (const splitPath of splits) {
      const base = path.basename(splitPath);
      const z = zip.open(splitPath);
      const soAlign = Math.max(16384, ...z.entries
        .filter((e) => e.name.endsWith('.so'))
        .map((e) => zip.observedAlignment(z, e)));

      const items = [];
      let changedCount = 0;
      for (const e of z.entries) {
        if (DROP_ENTRIES.has(e.name)) continue;

        const applicable = selected.filter((p) => p.targets(e.name, { opts }));
        if (applicable.length) {
          let buf = zip.readData(z, e);
          let touched = false;
          for (const p of applicable) {
            const next = p.transform(e.name, buf, { opts, split: base });
            if (next) { buf = next; touched = true; }
          }
          if (touched) {
            changedCount++;
            items.push({
              name: e.name,
              data: buf,
              compress: e.method === zip.DEFLATED,
              align: e.method === zip.STORED ? zip.observedAlignment(z, e) : 1,
              externalAttr: e.externalAttr,
            });
            continue;
          }
        }

        items.push({
          name: e.name, method: e.method, crc32: e.crc32,
          compSize: e.compSize, uncompSize: e.uncompSize,
          raw: zip.readRaw(z, e),
          flags: e.flags, modTime: e.modTime, modDate: e.modDate,
          versionMadeBy: e.versionMadeBy, versionNeeded: e.versionNeeded,
          externalAttr: e.externalAttr,
        });
      }
      zip.close(z);

      const outPath = path.join(outDir, base);
      zip.write(outPath, items, { soAlign });
      sign(outPath);
      console.log(`  ${base.padEnd(24)} ${changedCount} entry(s) patched, signed`);
    }

    console.log(`\noutput: ${outDir}`);
    console.log(`install: bravepatch install ${outDir}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function cmdInstall(dir) {
  const apks = fs.readdirSync(dir).filter((f) => f.endsWith('.apk')).map((f) => path.join(dir, f));
  if (!apks.length) die('no .apk files in ' + dir);
  console.log('installing: ' + apks.map((a) => path.basename(a)).join(', '));
  execFileSync('adb', ['install-multiple', '-r', ...apks], { stdio: 'inherit' });
}

function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { opts, rest } = parseArgs(argv);
  if (opts.pkg) opts.to = opts.pkg;

  if (cmd === 'probe') cmdProbe(rest[0] || die('need input'), opts);
  else if (cmd === 'build') cmdBuild(rest[0] || die('need input'), opts);
  else if (cmd === 'install') cmdInstall(rest[0] || die('need output dir'));
  else {
    console.log(`bravepatch — re-appliable Brave debloat patcher

  probe   <in.apks>                 check that every patch anchor still matches
  build   <in.apks> -o <outdir>     patch, repack, sign
  install <outdir>                  adb install-multiple

options
  --patch <id,id>   only run these patches (default: all)
  --pkg <name>      new applicationId (must be the same length as the original)
  --dex <path>      rebuilt classes.dex for the dexswap patch
  --dex-chrome <p>  rebuilt split_chrome classes.dex for dexswap-chrome
  --icon-entry <n>  res/ entry to overwrite for iconswap (e.g. res/D4Y.xml)
  --icon-file <p>   compiled drawable to write into that entry

patches: ${registry.all.map((p) => p.id).join(', ')}`);
    process.exit(cmd ? 1 : 0);
  }
}

main();
