#!/usr/bin/env node
/**
 * register-hooks — install wmem's SessionStart + SessionEnd hooks into
 * Claude Code's settings.json idempotently.
 *
 * Claude Code reads hooks from `~/.claude/settings.json` under the
 * `hooks` key:
 *
 *   {
 *     "hooks": {
 *       "SessionStart": [ { "matcher": "*", "hooks": [ {type, command} ] } ],
 *       "SessionEnd":   [ { "matcher": "*", "hooks": [ {type, command} ] } ]
 *     }
 *   }
 *
 * Usage:
 *   node scripts/register-hooks.mjs                # idempotent install
 *   node scripts/register-hooks.mjs --uninstall    # remove our hooks
 *   node scripts/register-hooks.mjs --print        # show current state
 *   node scripts/register-hooks.mjs --settings <path>   # override path
 *
 * Idempotent: existing wmem hook entries (identified by command path) get
 * left alone; foreign hooks (other tools' commands) get preserved
 * untouched. Re-running just replaces the wmem entries with current
 * resolved paths.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WMEM_ROOT = resolve(__dirname, '..');

const HOOK_FILES = {
  SessionStart: join(WMEM_ROOT, 'scripts', 'session-start-hook.sh'),
  SessionEnd:   join(WMEM_ROOT, 'scripts', 'session-end-hook.sh'),
};

const argv = process.argv.slice(2);
const flags = { uninstall: false, print: false };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--uninstall') flags.uninstall = true;
  else if (argv[i] === '--print') flags.print = true;
  else if (argv[i] === '--settings' && argv[i + 1]) flags.settings = argv[++i];
}

const settingsPath = flags.settings || join(homedir(), '.claude', 'settings.json');

function loadSettings() {
  if (!existsSync(settingsPath)) return {};
  try { return JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { return {}; }
}

function saveSettings(obj) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(obj, null, 2) + '\n');
}

// Identify wmem hook entries by command path containing 'wmem' + the file
// basename. Conservative — we only remove entries that clearly look like ours.
function isOurHookEntry(entry, expectedCommand) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(h =>
    h?.type === 'command' &&
    typeof h?.command === 'string' &&
    h.command === expectedCommand
  );
}

function isAnyWmemHookEntry(entry) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(h =>
    h?.type === 'command' &&
    typeof h?.command === 'string' &&
    (h.command.includes('session-start-hook.sh') ||
     h.command.includes('session-end-hook.sh'))
  );
}

const settings = loadSettings();

if (flags.print) {
  console.log(JSON.stringify({
    settings_path: settingsPath,
    exists: existsSync(settingsPath),
    hooks: settings.hooks ?? {},
  }, null, 2));
  process.exit(0);
}

settings.hooks ??= {};

for (const [event, scriptPath] of Object.entries(HOOK_FILES)) {
  settings.hooks[event] ??= [];

  // Strip any prior wmem entries for this event (idempotent re-install)
  settings.hooks[event] = settings.hooks[event].filter(e => !isAnyWmemHookEntry(e));

  if (!flags.uninstall) {
    // Add a fresh entry with current resolved path
    settings.hooks[event].push({
      matcher: '*',
      hooks: [{ type: 'command', command: scriptPath }],
    });
    console.log(`✓ ${event}: ${scriptPath}`);
  } else {
    console.log(`✓ uninstalled ${event} hook`);
  }

  // Tidy empty arrays after uninstall
  if (settings.hooks[event].length === 0) delete settings.hooks[event];
}

if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

saveSettings(settings);
console.log(`\n${flags.uninstall ? 'removed from' : 'wrote to'} ${settingsPath}`);
if (!flags.uninstall) {
  console.log('Hooks will fire on next Claude Code session start/end.');
}
