#!/usr/bin/env node
/** PostToolUse hook — records file activity. Never blocks the tool call. */
import { config, readStdin, runScript, recordFire } from './lib.mjs';
config();
const payload = readStdin();
const ok = runScript('scripts/posttooluse-record-file.mjs', [], { input: payload }).ok;
recordFire('PostToolUse', { ok });
process.exit(0);
