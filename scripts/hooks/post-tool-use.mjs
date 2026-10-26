#!/usr/bin/env node
/**
 * PostToolUse hook — records file activity. Never blocks the tool call.
 *
 * THIS EVENT IS IN A DIFFERENT COST CLASS FROM THE OTHER TWO, and the first version did not
 * respect that. SessionStart and SessionEnd fire once each and may cost whatever they like.
 * PostToolUse fires on EVERY tool call, so its per-call cost multiplies by how hard someone
 * is working — the heaviest users get the worst experience, which is backwards.
 *
 * The first version read the rc file, read stdin, SPAWNED A FULL NODE PROCESS, and did a
 * read-modify-write of the stamp. Claude Code has already spawned node to run this hook, so
 * that was two node startups per tool call — 40-80ms of cold start each on Windows before a
 * single import. Measured by someone running eight panes against one store, which is the
 * only way this shows up at all.
 *
 * Now: no child process — the recorder is imported in-process, which halves the startups for
 * free. And no stdin read here, because the recorder reads stdin itself at module scope;
 * reading it first would consume the stream and hand it an empty payload.
 *
 * The stamp goes BEFORE the import, because the recorder ends in process.exit(0) and
 * anything after it would never run.
 */
import { config, recordFire } from './lib.mjs';

config();
recordFire('PostToolUse', {}, { throttleMs: 60_000 });
await import('../posttooluse-record-file.mjs');   // reads stdin, records, exits 0
