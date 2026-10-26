#!/usr/bin/env node
/**
 * register-hooks — install wmem's hooks into Claude Code's settings.json.
 *
 * Three changes from the version this replaces, each one a reported bug:
 *
 *   1. THE COMMANDS ARE NODE, NOT BASH (#19). It installed `.sh` files that use bash-only
 *      constructs and shell out to python3. On a Windows host neither is reliably present,
 *      so every hook silently did nothing. Node runs the hooks now, invoked through
 *      process.execPath so it is the same node that installed them.
 *
 *   2. POSTTOOLUSE IS REGISTERED (#16/#20). Only SessionStart and SessionEnd were in the
 *      map, while scripts/posttooluse-record-file.sh existed and was documented. A hook
 *      that ships but is never registered is indistinguishable from one that is broken.
 *
 *   3. IT VERIFIES INSTEAD OF REPORTING. It used to print "✓ SessionStart: <path>" after
 *      writing and never look again. Now it re-reads the file it just wrote and reports
 *      what is actually in there. "Installed" should mean observed — a fortnight was lost
 *      once to an installer that had succeeded at *attempting*.
 *
 * Old `.sh` entries are recognised and replaced, so upgrading does not leave two hooks on
 * one event.
 *
 * Usage:
 *   node scripts/register-hooks.mjs                 install (idempotent)
 *   node scripts/register-hooks.mjs --uninstall     remove ours, leave everyone else's
 *   node scripts/register-hooks.mjs --print         show what is registered now
 *   node scripts/register-hooks.mjs --print-only    show the JSON we WOULD write
 *   node scripts/register-hooks.mjs --settings <p>  override the settings path
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const WMEM_ROOT = resolve(__dirname, '..');

const HOOK_FILES = {
  SessionStart: join(WMEM_ROOT, 'scripts', 'hooks', 'session-start.mjs'),
  SessionEnd:   join(WMEM_ROOT, 'scripts', 'hooks', 'session-end.mjs'),
  PostToolUse:  join(WMEM_ROOT, 'scripts', 'hooks', 'post-tool-use.mjs'),
  // PreCompact: NOT PORTED YET — plugins/wmem/hooks/pre-compact.sh is still bash, and so
  // is the rest of the plugin route (Setup, SessionStart, SessionEnd). The node port covers
  // three of the four events the bash route had, so #19 is fixed for scripts/ and open for
  // plugins/. Stated here because a missing capability should be visible from the code
  // rather than from diffing two trees.
  //
  // PreCompact is also the one worth having most: the compact boundary is the moment
  // context is lost, and the only moment where "write down what matters now" has a
  // deadline. It is the natural WRITE side for the rulings memory_last_session reads —
  // which is why that query returns empty on stores where nothing ever banked one.
};

// Quote both halves: on Windows the node path contains "Program Files" more often than not,
// and an unquoted command is a path that works on the author's machine only.
const commandFor = (script) => `"${process.execPath}" "${script}"`;

const argv = process.argv.slice(2);
const flags = { uninstall: false, print: false, printOnly: false, settings: null };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--uninstall') flags.uninstall = true;
  else if (argv[i] === '--print') flags.print = true;
  else if (argv[i] === '--print-only') flags.printOnly = true;
  else if (argv[i] === '--settings' && argv[i + 1]) flags.settings = argv[++i];
}
const settingsPath = flags.settings || join(homedir(), '.claude', 'settings.json');

const load = () => { try { return JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { return {}; } };

// Ours = any entry whose command mentions one of our hook scripts, under either the new
// scripts/hooks/*.mjs names or the old scripts/*-hook.sh ones.
const OURS = /scripts[\\/](hooks[\\/](session-start|session-end|post-tool-use)\.mjs|(session-start|session-end)-hook\.sh|posttooluse-record-file\.sh)/;
const isOurs = (entry) => Array.isArray(entry?.hooks) &&
  entry.hooks.some(h => h?.type === 'command' && typeof h.command === 'string' && OURS.test(h.command));

const settings = load();

if (flags.print) {
  console.log(JSON.stringify({ settings_path: settingsPath, exists: existsSync(settingsPath), hooks: settings.hooks ?? {} }, null, 2));
  process.exit(0);
}

settings.hooks ??= {};
for (const [event, script] of Object.entries(HOOK_FILES)) {
  settings.hooks[event] = (settings.hooks[event] ?? []).filter(e => !isOurs(e));   // idempotent, and migrates .sh → .mjs
  if (!flags.uninstall) {
    if (!existsSync(script)) { console.error(`! ${event}: ${script} does not exist — refusing to register a hook that cannot run`); continue; }
    settings.hooks[event].push({ matcher: '*', hooks: [{ type: 'command', command: commandFor(script) }] });
  }
  if (settings.hooks[event].length === 0) delete settings.hooks[event];
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

if (flags.printOnly) {
  console.log(JSON.stringify({ hooks: settings.hooks ?? {} }, null, 2));
  console.log(`\n(nothing written. this is what would go into ${settingsPath})`);
  process.exit(0);
}

mkdirSync(dirname(settingsPath), { recursive: true });
if (existsSync(settingsPath)) {
  const bak = `${settingsPath}.wmem-backup`;
  copyFileSync(settingsPath, bak);        // one rolling backup: the file is the user's, not ours
}
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

// VERIFY. Read back what is on disk and report that, not what we intended.
const after = load();
let bad = 0;
for (const [event, script] of Object.entries(HOOK_FILES)) {
  const present = (after.hooks?.[event] ?? []).some(e =>
    e.hooks?.some(h => h.command === commandFor(script)));
  if (flags.uninstall) {
    console.log(present ? `! ${event}: STILL PRESENT` : `✓ ${event}: removed`);
    if (present) bad++;
  } else {
    console.log(present ? `✓ ${event}: registered → ${script}` : `! ${event}: NOT REGISTERED after write`);
    if (!present) bad++;
  }
}
console.log(`\n${flags.uninstall ? 'removed from' : 'wrote'} ${settingsPath}${existsSync(settingsPath + '.wmem-backup') ? ' (previous copy at .wmem-backup)' : ''}`);
if (!flags.uninstall && !bad) {
  console.log('Hooks fire on the NEXT session — this one already started.');
  console.log('Confirm they actually ran: `wmem doctor --hooks`');
}
process.exit(bad ? 1 : 0);
