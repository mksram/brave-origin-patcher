#!/usr/bin/env node
'use strict';
// Inject Brave enterprise policies into PolicyProvider.notifySettingsAvailable(Bundle).
//
// Every provider funnels its restrictions Bundle through this one method before
// CombinedPolicyProvider merges it and hands it to native. Adding keys here is
// therefore equivalent to having an MDM push them, which is the mechanism Brave
// Origin itself uses.
//
// The method is located by the log literal it contains, not by its class or
// method name: R8 renames those on every release, the literal survives.

const fs = require('fs');
const path = require('path');

const ANCHOR = '"#notifySettingsAvailable() "';
const MARKER = '# bravepatch:policy';

// true  => feature forced on   (privacy hardening)
// false => feature forced off  (bloat, telemetry)
const POLICIES = {
  BraveRewardsDisabled: true,
  BraveWalletDisabled: true,
  BraveVPNDisabled: true,
  BraveTalkDisabled: true,
  BraveNewsDisabled: true,

  BraveAIChatEnabled: false,
  BravePlaylistEnabled: false,

  BraveP3AEnabled: false,
  BraveStatsPingEnabled: false,
  BraveWebDiscoveryEnabled: false,

  BraveDeAmpEnabled: true,
  BraveDebouncingEnabled: true,
  BraveGlobalPrivacyControlEnabled: true,
  BraveReduceLanguageEnabled: true,
  BraveTrackingQueryParametersFilteringEnabled: true,

  // A policy also locks its setting and adds the "managed browser" banner, so
  // these four are only here because their entries are removed from the
  // settings UI as well — nothing the user can still see turns grey.
  MetricsReportingEnabled: false,
  PasswordManagerEnabled: false,
  AutofillCreditCardEnabled: false,
  AutofillAddressEnabled: false,
};

function die(msg) {
  console.error('error: ' + msg);
  process.exit(1);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.smali')) out.push(p);
  }
  return out;
}

function findAnchorFiles(smaliRoot) {
  return walk(smaliRoot).filter((f) => fs.readFileSync(f, 'utf8').includes(ANCHOR));
}

// The Bundle is dead by the time the original body reuses p1 as a loop counter,
// so we only have to stay clear of the two locals the body writes before reading.
function buildBlock(bundleReg) {
  const lines = [`    ${MARKER}`, `    if-eqz ${bundleReg}, :bravepatch_policy_done`, ''];
  for (const [key, value] of Object.entries(POLICIES)) {
    lines.push(`    const-string v1, "${key}"`);
    lines.push(`    const/4 v0, ${value ? '0x1' : '0x0'}`);
    lines.push(
      `    invoke-virtual {${bundleReg}, v1, v0}, Landroid/os/Bundle;->putBoolean(Ljava/lang/String;Z)V`
    );
    lines.push('');
  }
  lines.push('    :bravepatch_policy_done');
  lines.push('');
  return lines.join('\n');
}

function patchFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(MARKER)) return { status: 'already' };

  const lines = src.split('\n');

  // Locate the method that both declares a single Bundle parameter and contains
  // the anchor, so a class with several Bundle methods cannot be mispatched.
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\.method\s+.*\(Landroid\/os\/Bundle;\)V\s*$/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !/^\.end method/.test(lines[j])) j++;
    if (lines.slice(i, j).some((l) => l.includes(ANCHOR))) {
      if (start !== -1) return { status: 'ambiguous' };
      start = i;
      end = j;
    }
    i = j;
  }
  if (start === -1) return { status: 'no-method' };

  const localsIdx = lines.findIndex(
    (l, i) => i > start && i < end && /^\s*\.locals\s+\d+/.test(l)
  );
  if (localsIdx === -1) return { status: 'no-locals' };

  const locals = parseInt(/\.locals\s+(\d+)/.exec(lines[localsIdx])[1], 10);
  if (locals < 2) lines[localsIdx] = lines[localsIdx].replace(/\.locals\s+\d+/, '.locals 2');

  // Params are the highest registers: p0 = v<locals>, p1 = v<locals+1>. The
  // 3-register invoke-virtual form needs every operand below v16.
  const effLocals = Math.max(locals, 2);
  if (effLocals + 1 >= 16) return { status: 'p1-too-high' };

  lines.splice(localsIdx + 1, 0, '', buildBlock('p1'));
  fs.writeFileSync(file, lines.join('\n'));
  return { status: 'patched', method: lines[start].trim(), locals: effLocals };
}

function main() {
  const root = process.argv[2] || die('usage: policy-inject.js <decoded-apk-dir>');
  const smaliDirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^smali(_classes\d+)?$/.test(e.name))
    .map((e) => path.join(root, e.name));
  if (!smaliDirs.length) die('no smali dir under ' + root);

  const files = smaliDirs.flatMap(findAnchorFiles);
  console.log(`anchor   : ${ANCHOR}`);
  console.log(`policies : ${Object.keys(POLICIES).length}`);
  console.log(`matches  : ${files.length} file(s)\n`);
  if (!files.length) die('anchor not found — Brave changed the log literal, patch needs a new anchor');

  let patched = 0;
  for (const f of files) {
    const r = patchFile(f);
    console.log(`  ${path.relative(root, f)}: ${r.status}${r.method ? '  ' + r.method : ''}`);
    if (r.status === 'patched') patched++;
  }
  console.log(patched ? `\nPOLICY INJECTED (${patched} method(s))` : '\nNOTHING PATCHED');
  process.exit(patched ? 0 : 1);
}

main();
