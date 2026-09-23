#!/usr/bin/env node
'use strict';
// Layer 2: everything that lives in split_chrome's dex.
//
//   node settings-patch.js <decoded-split_chrome-dir> --menu-id 0x7f01092c
//
// Five independent edits, each anchored on something R8 cannot rename — an
// unobfuscated class name, a string literal, or a framework type signature:
//
//   hide     drop settings rows that a policy has already locked, so nothing
//            the user can still see says "managed by your organization"
//   update   cut the one funnel every update check and update prompt goes
//            through, so the browser never asks about new versions again
//   menu     drop the "Managed browser" app-menu item
//   qse      rewrite Bing's quick-search entry into Google's AI Mode
//   qseicon  report the drawable id that entry's icon is hardcoded to, so the
//            build can replace the image it points at

const fs = require('fs');
const path = require('path');

const MAIN_CLASS = 'org/chromium/chrome/browser/settings/BraveMainPreferencesBase.smali';
const PRIVACY_CLASS = 'org/chromium/chrome/browser/privacy/settings/BravePrivacySettings.smali';

// autofill_options ("Autofill services") deliberately stays: it is the hand-off
// to whatever autofill app the user actually uses.
const MAIN_HIDE = [
  'passwords',
  'autofill_payment_methods',
  'autofill_addresses',
  'rate_brave',
  'brave_origin',
  'brave_stats',
];

const PRIVACY_HIDE = [
  'send_crash_reports',
  'send_p3a_analytics',
  'survey_panelist',
  'survey_panelist_learn_more',
  'brave_stats_usage_ping',
];

const QSE_MATCH = 'bing.com';
const QSE_NAME = 'Google AI Mode';
const QSE_URL = 'https://www.google.com/search?udm=50&aep=48&q={searchTerms}';
// Brave gives each quick-search engine a shortcut keyword; Bing's is this one.
const QSE_ICON_KEYWORD = ':b';

const QSE_CTOR = /invoke-direct\/range\s+\{v(\d+)\s*\.\.\s*v(\d+)\},\s+(L[^;]+;)-><init>\(Ljava\/lang\/String;Ljava\/lang\/String;Ljava\/lang\/String;ZI\)V/;
const QSE_METHOD = /^\.method\s+.*\(Ljava\/util\/LinkedHashMap;Lorg\/chromium\/components\/search_engines\/TemplateUrl;\)V\s*$/;

let fail = 0;
function die(msg) {
  console.error('error: ' + msg);
  process.exit(1);
}
function report(label, detail) {
  console.log(`  ${label.padEnd(10)} ${detail}`);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.smali')) out.push(p);
  }
  return out;
}

function smaliDirs(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^smali(_classes\d+)?$/.test(e.name))
    .map((e) => path.join(root, e.name));
}

function locate(root, rel) {
  for (const d of smaliDirs(root)) {
    const p = path.join(d, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function classOf(lines) {
  const m = /^\.class\s+.*?(L[^;]+;)\s*$/.exec(lines[0]);
  return m && m[1];
}

// [{ name, sig, start, end }] for every method in the file, in source order.
function methods(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\.method\s+(?:[\w-]+\s+)*([\w$<>]+)(\([^)]*\).+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !/^\.end method/.test(lines[j])) j++;
    out.push({ name: m[1], sig: m[2], start: i, end: j });
    i = j;
  }
  return out;
}

function localsLine(lines, m) {
  for (let i = m.start + 1; i < m.end; i++) if (/^\s*\.locals\s+\d+/.test(lines[i])) return i;
  return -1;
}

function bumpLocals(lines, m, want) {
  const idx = localsLine(lines, m);
  if (idx === -1) die('method has no .locals: ' + lines[m.start].trim());
  const have = parseInt(/\.locals\s+(\d+)/.exec(lines[idx])[1], 10);
  if (have < want) lines[idx] = lines[idx].replace(/\.locals\s+\d+/, `.locals ${want}`);
  return { idx, have, now: Math.max(have, want) };
}

// ---------------------------------------------------------------- hide rows

// Brave's own "remove this row from the screen" helper. Its name is renamed on
// every release; its shape — a void String method that reaches into the
// PreferenceScreen and removes a Preference — is not.
function findRemoveHelper(lines, ms) {
  const hits = ms.filter((m) => {
    if (m.sig !== '(Ljava/lang/String;)V') return false;
    const body = lines.slice(m.start, m.end).join('\n');
    return (
      body.includes('()Landroidx/preference/PreferenceScreen;') &&
      body.includes('(Landroidx/preference/Preference;)V')
    );
  });
  if (hits.length !== 1) return null;
  return hits[0].name;
}

function hideRows(root, rel, keys, label) {
  const file = locate(root, rel) || die(rel + ' not in this dex — wrong split?');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const MARKER = '# bravepatch:hide';
  if (lines.some((l) => l.includes(MARKER))) {
    report(label, 'already');
    return;
  }

  const cls = classOf(lines) || die('no .class line in ' + rel);
  const ms = methods(lines);
  const helper = findRemoveHelper(lines, ms) || die('no remove-preference helper in ' + rel);

  // The row set is rebuilt from scratch on every display pass, so the removals
  // belong in whichever method does that rebuilding — the one that already
  // calls the helper most often.
  const call = `->${helper}(Ljava/lang/String;)V`;
  let target = null;
  let best = 0;
  for (const m of ms) {
    if (/\bstatic\b/.test(lines[m.start])) continue; // p0 must be `this`
    const n = lines.slice(m.start, m.end).filter((l) => l.includes(call)).length;
    if (n > best) {
      best = n;
      target = m;
    }
  }
  if (!target) die('nothing calls the remove helper in ' + rel);

  bumpLocals(lines, target, 2);
  const block = [`    ${MARKER}`, '    move-object/from16 v0, p0'];
  for (const k of keys) {
    block.push(`    const-string v1, "${k}"`);
    block.push(`    invoke-virtual {v0, v1}, ${cls}${call}`);
  }
  block.push('');

  // Every exit runs the same removals; the helper is a no-op for a row that is
  // already gone, so repeating it across branches costs nothing.
  let inserted = 0;
  for (let i = target.end - 1; i > target.start; i--) {
    if (!/^\s*return-void\s*$/.test(lines[i])) continue;
    lines.splice(i, 0, ...block);
    inserted++;
  }
  if (!inserted) die('no return-void in the target method of ' + rel);

  fs.writeFileSync(file, lines.join('\n'));
  report(label, `${keys.length} row(s) via ${cls}->${helper}, ${inserted} exit(s)`);
}

// --------------------------------------------------------------- update kill

// One object owns the update state: it runs the version check lazily when the
// first observer subscribes, and every consumer — app-menu badge, update
// notification, safety hub — reads it through that subscription. Emptying the
// subscribe method therefore stops the check and every prompt it feeds.
function killUpdates(root, files) {
  const task = files.find((f) => {
    const s = fs.readFileSync(f, 'utf8');
    return s.includes('"force-update-menu-type"') && s.includes('"latestVersion"');
  });
  if (!task) die('no update-check class — the update literals moved');
  const taskClass = classOf(fs.readFileSync(task, 'utf8').split('\n'));

  const holder = files.filter((f) => {
    const s = fs.readFileSync(f, 'utf8');
    return new RegExp(`^\\.field\\s+.*:${taskClass.replace(/[$]/g, '\\$')}$`, 'm').test(s);
  });
  if (holder.length !== 1) die(`expected one holder of ${taskClass}, found ${holder.length}`);

  const lines = fs.readFileSync(holder[0], 'utf8').split('\n');
  const MARKER = '# bravepatch:noupdate';
  if (lines.some((l) => l.includes(MARKER))) {
    report('update', 'already');
    return;
  }
  const cls = classOf(lines);
  const subs = methods(lines).filter((m) => m.sig === '(Lorg/chromium/base/Callback;)V');
  if (subs.length !== 1) die(`expected one observer-registration method on ${cls}, found ${subs.length}`);

  const m = subs[0];
  lines.splice(m.start + 1, m.end - m.start - 1, `    ${MARKER}`, '    .locals 0', '    return-void');
  fs.writeFileSync(holder[0], lines.join('\n'));
  report('update', `${cls}->${m.name}(Callback) emptied  [task ${taskClass}]`);
}

// ------------------------------------------------------- managed-browser item

// The item is built inside `if (isManaged) { ... }`. Turning that test into an
// unconditional jump past the block drops the row without touching anything
// that reads the managed state for other reasons.
function dropMenuItem(files, menuId) {
  const needle = new RegExp(`^\\s*const\\s+v\\d+,\\s+${menuId}\\s*$`);
  const MARKER = '# bravepatch:nomanaged';
  let patched = 0;
  let already = 0;

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (!src.includes(menuId)) continue;
    const lines = src.split('\n');
    if (!lines.some((l) => needle.test(l))) continue;
    if (src.includes(MARKER)) {
      already++;
      continue;
    }
    let touched = false;
    for (let i = 0; i < lines.length; i++) {
      if (!needle.test(lines[i])) continue;
      for (let j = i - 1; j >= 0 && i - j < 60; j--) {
        const g = /^\s*if-eqz\s+(v\d+),\s+(:[\w]+)\s*$/.exec(lines[j]);
        if (!g) continue;
        // Only the guard that consumes a freshly returned boolean qualifies;
        // the same id also appears in the click handler, behind a plain compare.
        const prev = lines.slice(0, j).reverse().find((l) => l.trim() && !/^\s*\.line/.test(l));
        if (!new RegExp(`^\\s*move-result\\s+${g[1]}\\s*$`).test(prev || '')) break;
        if (!lines.slice(i).some((l) => l.trim() === g[2])) break;
        lines[j] = `    ${MARKER}\n    goto/16 ${g[2]}`;
        touched = true;
        break;
      }
    }
    if (touched) {
      fs.writeFileSync(f, lines.join('\n'));
      patched++;
    }
  }
  if (!patched && !already) die(`no guarded use of ${menuId} — the managed-browser item moved`);
  report('menu', already && !patched ? 'already' : `${patched} file(s) carrying ${menuId}`);
}

// ------------------------------------------------------------ quick search

// A quick-search row is a plain (shortName, keyword, url) triple and the search
// is a literal {searchTerms} substitution, so swapping two of the three fields
// at construction time is enough. The keyword is left alone: it is the map key
// the enabled/disabled state is stored under.
function retargetQuickSearch(root, files) {
  const owner = files.find((f) => {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    return lines.some((l) => QSE_METHOD.test(l));
  });
  if (!owner) die('no quick-search-engine builder — the TemplateUrl signature moved');

  const lines = fs.readFileSync(owner, 'utf8').split('\n');
  const MARKER = '# bravepatch:qse';
  if (lines.some((l) => l.includes(MARKER))) {
    report('qse', 'already');
    return;
  }

  // Both the live TemplateUrl list and the persisted JSON feed the same
  // constructor, and a stale persisted row would otherwise keep the old name.
  let patched = 0;
  for (const m of methods(lines).slice().reverse()) {
    const hits = [];
    for (let i = m.start; i < m.end; i++) if (QSE_CTOR.test(lines[i])) hits.push(i);
    if (!hits.length) continue;

    const idx = localsLine(lines, m);
    if (idx === -1) die('quick-search builder has no .locals');
    const have = parseInt(/\.locals\s+(\d+)/.exec(lines[idx])[1], 10);
    if (have >= 16) die('quick-search builder has no register left below v16');
    const scratch = `v${have}`;
    bumpLocals(lines, m, have + 1);

    for (const i of hits.reverse()) {
      const g = QSE_CTOR.exec(lines[i]);
      const first = parseInt(g[1], 10);
      const name = `v${first + 1}`;
      const url = `v${first + 3}`;
      lines.splice(i, 0, [
        `    ${MARKER}`,
        `    if-eqz ${url}, :bravepatch_qse_${i}`,
        `    const-string ${scratch}, "${QSE_MATCH}"`,
        `    invoke-virtual {${url}, ${scratch}}, Ljava/lang/String;->contains(Ljava/lang/CharSequence;)Z`,
        `    move-result ${scratch}`,
        `    if-eqz ${scratch}, :bravepatch_qse_${i}`,
        `    const-string ${name}, "${QSE_NAME}"`,
        `    const-string ${url}, "${QSE_URL}"`,
        `    :bravepatch_qse_${i}`,
        '',
      ].join('\n'));
      patched++;
    }
  }
  if (!patched) die('quick-search builder has no recognisable row constructor');
  fs.writeFileSync(owner, lines.join('\n'));
  report('qse', `${patched} constructor(s) in ${path.basename(owner)} -> "${QSE_NAME}"`);
}

// ------------------------------------------------------------- engine icon

// The row's icon does not come from the row. Both binders compare the keyword
// against a short list and call setImageResource with a hardcoded drawable id
// for each match, so the retargeted entry keeps drawing Bing's mark no matter
// what its name and URL say. Nothing here is rewritten: the id is reported so
// the build can replace the drawable it resolves to, which is the only way to
// move the image without disturbing the keyword — the map key the enabled state
// and the row order are stored under.
function findIconId(files, emitPath) {
  const KEY = new RegExp(`^\\s*const-string\\s+[vp]\\d+,\\s+"${QSE_ICON_KEYWORD}"\\s*$`);
  const SET = /^\s*invoke-virtual\s+\{[vp]\d+,\s*([vp]\d+)\},\s+Landroid\/widget\/ImageView;->setImageResource\(I\)V\s*$/;

  const found = new Map();
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!KEY.test(lines[i])) continue;
      // The literal is only the branch we want when it is compared, not stored.
      const window = lines.slice(i, i + 30);
      if (!window.some((l) => l.includes('Ljava/lang/String;->equals(Ljava/lang/Object;)Z'))) continue;

      for (let j = i + 1; j < Math.min(i + 30, lines.length); j++) {
        const c = /^\s*const\s+([vp]\d+),\s+(0x7f[0-9a-f]+)\s*$/.exec(lines[j]);
        if (!c) continue;
        const use = lines.slice(j + 1, j + 6).find((l) => SET.test(l));
        if (!use || SET.exec(use)[1] !== c[1]) break;
        found.set(path.basename(f), c[2]);
        break;
      }
    }
  }

  const ids = [...new Set(found.values())];
  if (!found.size) die(`no hardcoded icon for the "${QSE_ICON_KEYWORD}" row — the binders changed shape`);
  if (ids.length !== 1) {
    die(`the "${QSE_ICON_KEYWORD}" row draws more than one drawable: ${[...found].map(([f, id]) => `${f}=${id}`).join(', ')}`);
  }

  if (emitPath) fs.writeFileSync(emitPath, ids[0] + '\n');
  report('qseicon', `${ids[0]} in ${[...found.keys()].join(', ')}`);
}

function main() {
  const argv = process.argv.slice(2);
  const root = argv.find((a) => !a.startsWith('-')) || die('usage: settings-patch.js <decoded-dir> --menu-id 0x…');
  const mi = argv.indexOf('--menu-id');
  const menuId = mi >= 0 ? argv[mi + 1] : die('--menu-id <managed_by_menu_id> is required');
  const ei = argv.indexOf('--emit-icon-id');
  const emitPath = ei >= 0 ? argv[ei + 1] : null;

  const dirs = smaliDirs(root);
  if (!dirs.length) die('no smali dir under ' + root);
  const files = dirs.flatMap((d) => walk(d));

  hideRows(root, MAIN_CLASS, MAIN_HIDE, 'settings');
  hideRows(root, PRIVACY_CLASS, PRIVACY_HIDE, 'privacy');
  killUpdates(root, files);
  dropMenuItem(files, menuId);
  retargetQuickSearch(root, files);
  findIconId(files, emitPath);

  console.log('\nSPLIT_CHROME PATCHED');
}

main();
