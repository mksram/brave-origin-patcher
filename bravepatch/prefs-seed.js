#!/usr/bin/env node
'use strict';
// Seed Brave's default SharedPreferences once, at Application.onCreate().
//
// Chromium keeps three separate stores: Android SharedPreferences, native
// profile prefs behind PrefService, and native content settings. Only the first
// is reachable before native starts, so only settings backed by it are seeded
// here; the rest are handled by policy or left to the user.
//
// Two names are resolved at patch time rather than hardcoded, because R8
// renames them every release: the SharedPreferences holder field (read out of
// SharedPreferencesManager, whose own name survives) and nothing else. Every
// other symbol in the emitted block belongs to the Android framework.

const fs = require('fs');
const path = require('path');

const APP_CLASS = 'org/chromium/chrome/browser/base/SplitChromeApplication.smali';
const SPM_CLASS = 'org/chromium/base/shared_preferences/SharedPreferencesManager.smali';
const MARKER = '# bravepatch:prefs';
const SEEDED_KEY = 'bravepatch.seeded_v1';
const LOCALS = 5;

// 2100-01-01T00:00:00Z: far enough out that the promo schedulers never fire.
const NEVER = 4102444800000;

const MENU_ITEM_PREFIX = 'customizable_brave_menu_item_id_';

// Resource entry names of the app-menu items the customize-menu screen offers.
// true keeps an item, false hides it.
const MENU_ITEMS = {
  add_to_group_menu_id: false,
  new_window_menu_id: false,
  move_to_other_window_menu_id: false,
  manage_all_windows_menu_id: false,
  recent_tabs_menu_id: false,
  page_zoom_id: false,
  enable_price_tracking_menu_id: false,
  disable_price_tracking_menu_id: false,
  brave_shred_id: false,
  readaloud_menu_id: false,
  reader_mode_menu_id: false,
  open_webapk_id: false,
  get_image_descriptions_id: false,
  exit_id: true,
};

const BOOLEANS = {
  // Skips the "Help make Brave better" / P3A pages of first run.
  p3a_crash_reporting_message_shown: true,
  p3a_onboarding: true,

  show_brave_stats: false,
  brave_stats: false, // privacy report notification

  Chrome_Tab_ArchiveEnabled: true,
  Chrome_Tab_ArchiveAutoDeleteEnabled: true,
  Chrome_Tab_ArchiveAutoDeleteDecisionMade: true, // suppresses the opt-in prompt

  Chrome_AdaptiveToolbarCustomization_Enabled: true,

  brave_rate_dont_show_again: true,
  brave_default_set_counter: false, // stops the default-browser promo being scheduled

  incognito_screenshot: true,
};

const INTS = {
  ui_theme_setting: 1, // 1 = Light
  Chrome_Tab_ArchiveTimeDeltaHours: 168, // 7 days
  Chrome_AdaptiveToolbarCustomization_Settings: 2, // 2 = new tab
  brave_default_timer_day: -1,
};

const LONGS = {
  brave_default_show_time: NEVER,
  next_rate_date: NEVER,
};

// The Chrome.* keys carry dots, which the object literals above spell with
// underscores; restore them on the way out.
function unmangle(k) {
  if (!k.startsWith('Chrome_')) return k;
  return k.split('_').reduce((acc, part, i) => (i === 0 ? part : acc + '.' + part));
}

function die(msg) {
  console.error('error: ' + msg);
  process.exit(1);
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

// Every accessor in SharedPreferencesManager reads the same static field. Its
// owner is obfuscated; the reference is lifted verbatim so it stays correct.
function findPrefsField(root) {
  const p = locate(root, SPM_CLASS) || die('SharedPreferencesManager not in this dex — wrong split?');
  const src = fs.readFileSync(p, 'utf8');
  const refs = [...src.matchAll(/sget-object\s+[vp]\d+,\s+(L[^;]+;->\w+:Landroid\/content\/SharedPreferences;)/g)].map(
    (m) => m[1]
  );
  if (!refs.length) die('no SharedPreferences field referenced from SharedPreferencesManager');
  const unique = [...new Set(refs)];
  if (unique.length > 1) die('ambiguous SharedPreferences fields: ' + unique.join(', '));
  return unique[0];
}

function constInt(reg, v) {
  if (v >= -8 && v <= 7) return `    const/4 ${reg}, ${v < 0 ? '-0x' + (-v).toString(16) : '0x' + v.toString(16)}`;
  if (v >= -32768 && v <= 32767)
    return `    const/16 ${reg}, ${v < 0 ? '-0x' + (-v).toString(16) : '0x' + v.toString(16)}`;
  return `    const ${reg}, 0x${(v >>> 0).toString(16)}`;
}

function buildBlock(prefsField) {
  const L = [];
  const put = (iface, sig) => `    invoke-interface {v0, v1, v2}, Landroid/content/SharedPreferences$Editor;->${iface}${sig}`;

  L.push(`    ${MARKER}`);
  L.push('    :bravepatch_seed_try_start');

  // Child processes are named "<pkg>:<something>"; isolated ones cannot open
  // the data dir at all, so seeding is browser-process only.
  L.push('    invoke-static {}, Landroid/app/Application;->getProcessName()Ljava/lang/String;');
  L.push('    move-result-object v1');
  L.push('    const-string v2, ":"');
  L.push('    invoke-virtual {v1, v2}, Ljava/lang/String;->contains(Ljava/lang/CharSequence;)Z');
  L.push('    move-result v2');
  L.push('    if-nez v2, :bravepatch_seed_skip');
  L.push('');

  L.push(`    sget-object v0, ${prefsField}`);
  L.push(`    const-string v1, "${SEEDED_KEY}"`);
  L.push('    const/4 v2, 0x0');
  L.push('    invoke-interface {v0, v1, v2}, Landroid/content/SharedPreferences;->getBoolean(Ljava/lang/String;Z)Z');
  L.push('    move-result v2');
  L.push('    if-nez v2, :bravepatch_seed_skip');
  L.push('');
  L.push('    invoke-interface {v0}, Landroid/content/SharedPreferences;->edit()Landroid/content/SharedPreferences$Editor;');
  L.push('    move-result-object v0');
  L.push('');

  const bools = { ...BOOLEANS };
  for (const [id, keep] of Object.entries(MENU_ITEMS)) bools[MENU_ITEM_PREFIX + id] = keep;

  for (const [rawKey, value] of Object.entries(bools)) {
    L.push(`    const-string v1, "${unmangle(rawKey)}"`);
    L.push(`    const/4 v2, ${value ? '0x1' : '0x0'}`);
    L.push(put('putBoolean', '(Ljava/lang/String;Z)Landroid/content/SharedPreferences$Editor;'));
    L.push('');
  }

  for (const [rawKey, value] of Object.entries(INTS)) {
    L.push(`    const-string v1, "${unmangle(rawKey)}"`);
    L.push(constInt('v2', value));
    L.push(put('putInt', '(Ljava/lang/String;I)Landroid/content/SharedPreferences$Editor;'));
    L.push('');
  }

  for (const [rawKey, value] of Object.entries(LONGS)) {
    L.push(`    const-string v1, "${unmangle(rawKey)}"`);
    L.push(`    const-wide v3, 0x${value.toString(16)}L`);
    L.push(
      '    invoke-interface {v0, v1, v3, v4}, Landroid/content/SharedPreferences$Editor;->putLong(Ljava/lang/String;J)Landroid/content/SharedPreferences$Editor;'
    );
    L.push('');
  }

  L.push(`    const-string v1, "${SEEDED_KEY}"`);
  L.push('    const/4 v2, 0x1');
  L.push(put('putBoolean', '(Ljava/lang/String;Z)Landroid/content/SharedPreferences$Editor;'));
  L.push('    invoke-interface {v0}, Landroid/content/SharedPreferences$Editor;->apply()V');
  L.push('');
  L.push('    :bravepatch_seed_skip');
  L.push('    :bravepatch_seed_try_end');
  L.push('    .catchall {:bravepatch_seed_try_start .. :bravepatch_seed_try_end} :bravepatch_seed_catch');
  L.push('    goto :bravepatch_seed_done');
  L.push('');
  L.push('    :bravepatch_seed_catch');
  L.push('    move-exception v0');
  L.push('');
  L.push('    :bravepatch_seed_done');
  L.push('');
  return L.join('\n');
}

function main() {
  const root = process.argv[2] || die('usage: prefs-seed.js <decoded-apk-dir>');
  const appFile = locate(root, APP_CLASS) || die('SplitChromeApplication not in this dex — wrong split?');
  const src = fs.readFileSync(appFile, 'utf8');
  if (src.includes(MARKER)) {
    console.log('already seeded');
    return;
  }

  const prefsField = findPrefsField(root);
  const lines = src.split('\n');

  const start = lines.findIndex((l) => /^\.method\s+.*\bonCreate\(\)V\s*$/.test(l));
  if (start === -1) die('no onCreate()V in SplitChromeApplication');
  let end = start + 1;
  while (end < lines.length && !/^\.end method/.test(lines[end])) end++;

  const localsIdx = lines.findIndex((l, i) => i > start && i < end && /^\s*\.locals\s+\d+/.test(l));
  if (localsIdx === -1) die('onCreate has no .locals');

  const locals = parseInt(/\.locals\s+(\d+)/.exec(lines[localsIdx])[1], 10);
  const eff = Math.max(locals, LOCALS);
  if (eff !== locals) lines[localsIdx] = lines[localsIdx].replace(/\.locals\s+\d+/, `.locals ${eff}`);

  // p0 is the last register; the 2- and 3-operand invokes below need it < v16.
  if (eff >= 16) die('onCreate needs too many locals to inject safely');

  lines.splice(localsIdx + 1, 0, '', buildBlock(prefsField));
  fs.writeFileSync(appFile, lines.join('\n'));

  const count =
    Object.keys(BOOLEANS).length + Object.keys(MENU_ITEMS).length + Object.keys(INTS).length + Object.keys(LONGS).length;
  console.log(`prefs field : ${prefsField}`);
  console.log(`target      : ${path.relative(root, appFile)} onCreate()V (.locals ${locals} -> ${eff})`);
  console.log(`seeded keys : ${count}`);
  console.log('\nPREFS SEEDED');
}

main();
