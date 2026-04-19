#!/usr/bin/env node
/**
 * personality.mjs — CLI for personality management
 *
 * Usage:
 *   node scripts/personality.mjs list                    — show all personalities
 *   node scripts/personality.mjs use <name>              — activate a personality
 *   node scripts/personality.mjs create <name> [--template <t>] — create from template
 *   node scripts/personality.mjs show <name>             — show personality details
 *   node scripts/personality.mjs active                  — show active personality
 *   node scripts/personality.mjs delete <name>           — delete (memories preserved)
 *   node scripts/personality.mjs templates               — list built-in templates
 *   node scripts/personality.mjs import <file>           — import from JSON file
 *   node scripts/personality.mjs export <name> [<file>]  — export to JSON
 */

import {
  createPersonality, updatePersonality, getPersonality,
  listPersonalities, deletePersonality, activatePersonality,
  getActivePersonality, buildPersonalityL1, TEMPLATES,
} from '../core/personality.mjs';
import { readFileSync, writeFileSync } from 'fs';

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
    if (!name) { console.error('Usage: personality create <name> [--template <template>]'); process.exit(1); }

    const args = parseFlags(rest.slice(1));
    const templateName = args.template;
    const template = templateName ? TEMPLATES[templateName] : {};

    if (templateName && !template) {
      console.error(`Unknown template: ${templateName}. Available: ${Object.keys(TEMPLATES).join(', ')}`);
      process.exit(1);
    }

    createPersonality({
      name,
      displayName: args['display-name'] || template.displayName || name,
      description: args.description || template.description || '',
      systemPrompt: args.prompt || template.systemPrompt || '',
      voice: args.voice || template.voice || '',
      capabilities: template.capabilities || [],
      restrictions: template.restrictions || [],
      born: args.born || null,
    });

    console.log(`Created personality "${name}"${templateName ? ` from template "${templateName}"` : ''}.`);
    console.log(`Activate it: wmem personality use ${name}`);
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
  list                          Show all personalities
  use <name>                    Activate a personality
  create <name> [--template t]  Create new (templates: ${Object.keys(TEMPLATES).join(', ')})
  show [name]                   Show details (default: active)
  active                        Show active personality
  delete <name>                 Delete (memories preserved)
  templates                     List built-in templates
  import <file.json>            Import from JSON
  export <name> [file.json]     Export to JSON`);
}

function parseFlags(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && args[i + 1]) {
      result[args[i].slice(2)] = args[++i];
    }
  }
  return result;
}
