#!/usr/bin/env node
/**
 * personality.mjs — CLI for personality management
 *
 * Usage:
 *   node scripts/personality.mjs list                          — show all personalities
 *   node scripts/personality.mjs use <name>                    — activate a personality
 *   node scripts/personality.mjs create <name> [--template t] [--interactive] — create
 *   node scripts/personality.mjs update <name> [flags]         — update fields
 *   node scripts/personality.mjs show <name>                   — show personality details
 *   node scripts/personality.mjs active                        — show active personality
 *   node scripts/personality.mjs delete <name>                 — delete (memories preserved)
 *   node scripts/personality.mjs templates                     — list built-in templates
 *   node scripts/personality.mjs import <file>                 — import from JSON file
 *   node scripts/personality.mjs export <name> [<file>]        — export to JSON
 */

import {
  createPersonality, updatePersonality, getPersonality,
  listPersonalities, deletePersonality, activatePersonality,
  getActivePersonality, buildPersonalityL1, TEMPLATES,
} from '../core/personality.mjs';
import { readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline/promises';

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'list':
  case 'ls': {
    const all = listPersonalities();
    if (all.length === 0) {
      console.log('No personalities. Create one: wmem personality create <name> --template coder');
      break;
    }
    for (const p of all) {
      const marker = p.active ? '→ ' : '  ';
      console.log(`${marker}${p.name} — ${p.description || 'no description'}${p.active ? ' (active)' : ''}`);
    }
    break;
  }

  case 'use':
  case 'activate': {
    const name = rest[0];
    if (!name) { console.error('Usage: personality use <name>'); process.exit(1); }
    const result = activatePersonality(name);
    if (result.activated) {
      const p = getPersonality(name);
      console.log(`Switched to ${p.displayName || name}. Next session will load this personality.`);
    } else {
      console.error(`Personality "${name}" not found. Use 'personality list' to see available.`);
      process.exit(1);
    }
    break;
  }

  case 'create': {
    const name = rest[0];
    if (!name) { console.error('Usage: personality create <name> [--template <template>] [--interactive]'); process.exit(1); }

    const args = parseFlags(rest.slice(1));
    const templateName = args.template;
    const template = templateName ? TEMPLATES[templateName] : {};

    if (templateName && !template) {
      console.error(`Unknown template: ${templateName}. Available: ${Object.keys(TEMPLATES).join(', ')}`);
      process.exit(1);
    }

    let fields;
    if (args.interactive || args.i) {
      if (!process.stdin.isTTY) {
        console.error('--interactive requires a terminal. For scripted creation use flags: --display-name --description --voice --prompt --born');
        process.exit(1);
      }
      fields = await promptForFields(name, template);
    } else {
      fields = {
        name,
        displayName: args['display-name'] || template.displayName || name,
        description: args.description || template.description || '',
        systemPrompt: args.prompt || template.systemPrompt || '',
        voice: args.voice || template.voice || '',
        capabilities: template.capabilities || [],
        restrictions: template.restrictions || [],
        born: args.born || null,
      };
    }

    createPersonality(fields);
    console.log(`Created personality "${name}"${templateName ? ` from template "${templateName}"` : ''}.`);
    console.log(`Activate it: wmem personality use ${name}`);
    break;
  }

  case 'update':
  case 'edit': {
    const name = rest[0];
    if (!name) { console.error('Usage: personality update <name> [--display-name X] [--description X] [--voice X] [--prompt X] [--born X] [--capabilities a,b,c] [--restrictions a,b,c]'); process.exit(1); }
    if (!getPersonality(name)) { console.error(`Personality "${name}" not found.`); process.exit(1); }

    const args = parseFlags(rest.slice(1));
    const updates = {};
    if (args['display-name'] !== undefined) updates.displayName = args['display-name'];
    if (args.description    !== undefined) updates.description = args.description;
    if (args.voice          !== undefined) updates.voice = args.voice;
    if (args.prompt         !== undefined) updates.systemPrompt = args.prompt;
    if (args.born           !== undefined) updates.born = args.born;
    if (args.capabilities   !== undefined) updates.capabilities = splitList(args.capabilities);
    if (args.restrictions   !== undefined) updates.restrictions = splitList(args.restrictions);

    if (Object.keys(updates).length === 0) {
      console.error('No fields to update. Pass at least one of: --display-name, --description, --voice, --prompt, --born, --capabilities, --restrictions');
      process.exit(1);
    }

    const result = updatePersonality(name, updates);
    if (result.updated) {
      console.log(`Updated "${name}": ${Object.keys(updates).join(', ')}`);
    } else {
      console.log(`No changes for "${name}" — ${result.reason || 'nothing applied'}`);
    }
    break;
  }

  case 'show':
  case 'info': {
    const name = rest[0] || getActivePersonality()?.name;
    if (!name) { console.error('No personality specified and none active.'); process.exit(1); }
    const p = getPersonality(name);
    if (!p) { console.error(`Personality "${name}" not found.`); process.exit(1); }
    console.log(`Name:         ${p.name}${p.active ? ' (active)' : ''}`);
    console.log(`Display:      ${p.displayName}`);
    console.log(`Description:  ${p.description}`);
    console.log(`Voice:        ${p.voice}`);
    console.log(`Born:         ${p.born || 'not set'}`);
    if (p.capabilities.length) console.log(`Capabilities: ${p.capabilities.join(', ')}`);
    if (p.restrictions.length) console.log(`Restrictions: ${p.restrictions.join(', ')}`);
    if (p.systemPrompt) {
      console.log(`\nSystem prompt:\n${p.systemPrompt}`);
    }
    break;
  }

  case 'active': {
    const p = getActivePersonality();
    if (p) {
      console.log(`${p.displayName || p.name} — ${p.description}`);
    } else {
      console.log('No active personality. Using default agent.');
    }
    break;
  }

  case 'delete':
  case 'rm': {
    const name = rest[0];
    if (!name) { console.error('Usage: personality delete <name>'); process.exit(1); }
    const result = deletePersonality(name);
    if (result.deleted) {
      console.log(`Deleted personality "${name}". Memories are preserved — recreate to access them.`);
    } else {
      console.error(`Personality "${name}" not found.`);
    }
    break;
  }

  case 'templates': {
    for (const [name, t] of Object.entries(TEMPLATES)) {
      console.log(`  ${name} — ${t.description}`);
    }
    console.log(`\nCreate from template: wmem personality create myname --template ${Object.keys(TEMPLATES)[0]}`);
    break;
  }

  case 'import': {
    const file = rest[0];
    if (!file) { console.error('Usage: personality import <file.json>'); process.exit(1); }
    const data = JSON.parse(readFileSync(file, 'utf8'));
    createPersonality(data);
    console.log(`Imported personality "${data.name}".`);
    break;
  }

  case 'export': {
    const name = rest[0];
    if (!name) { console.error('Usage: personality export <name> [file.json]'); process.exit(1); }
    const p = getPersonality(name);
    if (!p) { console.error(`Personality "${name}" not found.`); process.exit(1); }
    const json = JSON.stringify(p, null, 2);
    const outFile = rest[1];
    if (outFile) {
      writeFileSync(outFile, json);
      console.log(`Exported to ${outFile}`);
    } else {
      console.log(json);
    }
    break;
  }

  default:
    console.log(`wmem personality — manage agent personalities

Commands:
  list                                       Show all personalities
  use <name>                                 Activate a personality
  create <name> [--template t] [--interactive]
                                             Create new (templates: ${Object.keys(TEMPLATES).join(', ')})
  update <name> [flags]                      Update fields (--display-name, --description, --voice,
                                             --prompt, --born, --capabilities a,b,c, --restrictions a,b,c)
  show [name]                                Show details (default: active)
  active                                     Show active personality
  delete <name>                              Delete (memories preserved)
  templates                                  List built-in templates
  import <file.json>                         Import from JSON
  export <name> [file.json]                  Export to JSON`);
}

function parseFlags(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      result[key] = true;
    } else {
      result[key] = next;
      i += 1;
    }
  }
  return result;
}

function splitList(value) {
  return String(value)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

async function promptForFields(name, template = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => {
    const prompt = def ? `${q} [${def}]: ` : `${q}: `;
    const answer = await rl.question(prompt);
    return answer.trim() === '' ? (def ?? '') : answer.trim();
  };

  console.log(`\nInteractive create for "${name}" — press Enter to accept [defaults]`);

  try {
    const displayName  = await ask('Display name', template.displayName || name);
    const description  = await ask('Description', template.description || '');
    const voice        = await ask('Voice (tone/style)', template.voice || '');
    const systemPrompt = await ask('System prompt', template.systemPrompt || '');
    const born         = await ask('Born (YYYY-MM-DD, optional)', '');
    const capsRaw      = await ask('Capabilities (comma-separated)', (template.capabilities || []).join(', '));
    const restRaw      = await ask('Restrictions (comma-separated)', (template.restrictions || []).join(', '));

    return {
      name,
      displayName,
      description,
      systemPrompt,
      voice,
      capabilities: splitList(capsRaw),
      restrictions: splitList(restRaw),
      born: born || null,
    };
  } finally {
    rl.close();
  }
}
