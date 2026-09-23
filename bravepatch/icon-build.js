#!/usr/bin/env node
'use strict';
// Compile the Google "G" mark into Android binary XML.
//
//   node icon-build.js -o <out.xml>
//
// Brave draws the Bing quick-search row from a hardcoded drawable id rather than
// from the row's keyword, so retargeting the row's name and URL leaves the old
// mark behind. The fix replaces the drawable the id already points at, which
// means we need that drawable in the same form the APK stores it: compiled
// binary XML, not source.
//
// The vector below uses nothing but framework attributes and literal colours, so
// the compiled result carries no resource references and can be dropped into any
// APK as-is.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const zip = require('./lib/zip');

const NAME = 'qse_g';

// 24dp / 24x24 viewport, matching the drawable being replaced.
const VECTOR = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#4285F4"
        android:pathData="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
    <path
        android:fillColor="#34A853"
        android:pathData="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
    <path
        android:fillColor="#FBBC05"
        android:pathData="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
    <path
        android:fillColor="#EA4335"
        android:pathData="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
</vector>
`;

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="bravepatch.icon" />
`;

// aapt2 link needs a framework to resolve android: attributes. apktool already
// depends on one and unpacks it on first run, so there is nothing extra to fetch.
const FRAMEWORKS = [
  path.join(os.homedir(), '.local/share/apktool/framework/1.apk'),
  path.join(os.homedir(), '.local/share/apktool/framework/1.apk.bak'),
];

function die(msg) {
  console.error('error: ' + msg);
  process.exit(1);
}

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const text = (err.stderr || err.stdout || Buffer.alloc(0)).toString('utf8').trim();
    die(`${cmd} ${args.join(' ')}\n${text}`);
  }
}

function framework() {
  const hit = FRAMEWORKS.find((p) => fs.existsSync(p));
  if (hit) return hit;
  die(
    'no apktool framework to link against — run `apktool d` on any APK once to unpack it, ' +
      'expected at ' + FRAMEWORKS[0]
  );
}

function build(outPath) {
  const work = fs.mkdtempSync(path.join(os.homedir(), 'icon-build-'));
  try {
    const res = path.join(work, 'res', 'drawable');
    fs.mkdirSync(res, { recursive: true });
    fs.writeFileSync(path.join(res, NAME + '.xml'), VECTOR);

    const manifest = path.join(work, 'AndroidManifest.xml');
    fs.writeFileSync(manifest, MANIFEST);

    const compiled = path.join(work, 'compiled.zip');
    run('aapt2', ['compile', '--dir', path.join(work, 'res'), '-o', compiled]);

    // Without a min-sdk, aapt2 assumes API 1, strips fillColor and pathData —
    // both API 21 — out of the default drawable and moves the real vector into a
    // -v21 variant. Naming a modern min-sdk keeps one unstripped file.
    const linked = path.join(work, 'icon.apk');
    run('aapt2', [
      'link', '-o', linked,
      '--min-sdk-version', '29',
      '--manifest', manifest,
      '-I', framework(),
      compiled,
    ]);

    const want = `res/drawable/${NAME}.xml`;
    const z = zip.open(linked);
    const variants = z.entries.filter((e) => e.name.endsWith(`/${NAME}.xml`)).map((e) => e.name);
    const entry = z.entries.find((e) => e.name === want);
    if (!entry) {
      zip.close(z);
      die(`aapt2 produced no ${want} (got: ${variants.join(', ') || 'nothing'})`);
    }
    if (variants.length !== 1) {
      zip.close(z);
      die(`aapt2 split the vector across config variants: ${variants.join(', ')}`);
    }
    const data = zip.readData(z, entry);
    zip.close(z);

    fs.writeFileSync(outPath, data);
    return { entry: entry.name, bytes: data.length };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  const oi = argv.indexOf('-o');
  const out = oi >= 0 ? argv[oi + 1] : die('usage: icon-build.js -o <out.xml>');
  const r = build(out);
  console.log(`icon: ${r.entry} -> ${out} (${r.bytes} bytes)`);
}

if (require.main === module) main();
module.exports = { build, VECTOR };
