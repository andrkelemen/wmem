/**
 * backfill-jsonl.mjs — One-time backfill of JSONL transcripts into wmem
 *
 * Walks JSONL files, extracts human+assistant message content,
 * chunks at ~500 tokens (~2000 chars), inserts into SQLite FTS5.
 *
 * Usage:
 *   node scripts/backfill-jsonl.mjs [--agent default] [--dir ~/.claude/projects]
 *   node scripts/backfill-jsonl.mjs --remote default   # SSH to pi, index the original JSONLs
 *
 * Skips subagent files by default (they are tool I/O, not conversation).
 */

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, createReadStream } from 'fs';
import { join, basename } from 'path';
import { createInterface } from 'readline';
import { insertChunk, getDb, close } from '../core/db.mjs';

const CHUNK_SIZE = 2000; // chars, roughly ~500 tokens
const CHUNK_OVERLAP = 200; // overlap between chunks for context continuity

// Parse CLI args
const args = process.argv.slice(2);
const agent = getArg('--agent') || 'default';
const baseDir = getArg('--dir') || `${process.env.HOME}/.claude/projects`;
const skipSubagents = !args.includes('--include-subagents');

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

// Find all JSONL files
function findJsonlFiles(dir) {
  const files = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipSubagents && entry.name === 'subagents') continue;
        files.push(...findJsonlFiles(full));
      } else if (entry.name.endsWith('.jsonl')) {
        files.push(full);
      }
    }
  } catch {}
  return files;
}

// Max content size to extract per message — prevents OOM on huge assistant responses
const MAX_CONTENT_CHARS = 10000;

// Extract text content from a JSONL message entry.
// Only reads entry.message (small), never entry.snapshot (huge — contains full conversation history).
function extractContent(entry) {
  const msg = entry.message;
  if (!msg || !msg.content) return null;

  const role = msg.role || entry.type;
  let text = '';

  if (typeof msg.content === 'string') {
    text = msg.content.slice(0, MAX_CONTENT_CHARS);
  } else if (Array.isArray(msg.content)) {
    // content blocks: [{ type: 'text', text: '...' }, ...]
    const parts = [];
    let len = 0;
    for (const b of msg.content) {
      if (b.type === 'text' && b.text) {
        const remaining = MAX_CONTENT_CHARS - len;
        if (remaining <= 0) break;
        parts.push(b.text.slice(0, remaining));
        len += parts[parts.length - 1].length;
      }
    }
    text = parts.join('\n');
  }

  if (!text || text.length < 10) return null;

  return { role, text, timestamp: entry.timestamp || 0, sessionId: entry.sessionId || null };
}

// Chunk text into ~CHUNK_SIZE pieces with overlap
function chunkText(text) {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    start = end - CHUNK_OVERLAP;
    if (start >= text.length) break;
  }
  return chunks;
}

// Track which files we've already indexed
const MANIFEST_PATH = join(baseDir, '.wmem-indexed.json');
function loadManifest() {
  try { return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')); } catch { return {}; }
}
function saveManifest(m) {
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

// Main (async for streaming)
async function main() {
console.log(`wmem backfill — agent: ${agent}, dir: ${baseDir}`);
console.log(`skip subagents: ${skipSubagents}`);

const manifest = loadManifest();
const files = findJsonlFiles(baseDir);
console.log(`found ${files.length} JSONL files`);

let totalInserted = 0;
let totalDeduped = 0;
let totalMessages = 0;
let filesProcessed = 0;

// Ensure DB is initialized
getDb();

// Process files sequentially, streaming line-by-line to avoid OOM on large JSONLs
async function processFile(file) {
  const key = file;
  const stat = statSync(file);
  const mtime = stat.mtimeMs;

  if (manifest[key] && manifest[key].mtime >= mtime) return;

  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let fileInserted = 0;

  for await (const line of rl) {
    if (!line) continue;
    // Quick type check before any parsing — skip non-message types entirely.
    // This is the critical OOM prevention: most lines are file-history-snapshots
    // with megabytes of snapshot data. Don't even try to parse them.
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') &&
        !line.includes('"type": "user"') && !line.includes('"type": "assistant"')) continue;

    // Extract only the fields we need without parsing the full line.
    // Ported from the original extract_dialogue() in chunk-session.py.
    // The 'message' field is small ({role, content}). The 'snapshot' field is huge.
    // We extract type, message, timestamp, sessionId via targeted regex, not full JSON.parse.
    let entry;
    try {
      // For lines under 100KB, full parse is safe and faster
      if (line.length < 100000) {
        entry = JSON.parse(line);
      } else {
        // Large line — extract fields without full parse
        const typeMatch = line.match(/"type"\s*:\s*"(user|assistant)"/);
        if (!typeMatch) continue;

        // Find the message object — it starts with "message":{"role" and we need to find its closing }
        const msgStart = line.indexOf('"message"');
        if (msgStart === -1) continue;
        const braceStart = line.indexOf('{', msgStart);
        if (braceStart === -1) continue;

        // Walk forward counting braces to find the matching close
        let depth = 0;
        let braceEnd = -1;
        for (let j = braceStart; j < Math.min(braceStart + MAX_CONTENT_CHARS + 1000, line.length); j++) {
          if (line[j] === '{') depth++;
          else if (line[j] === '}') { depth--; if (depth === 0) { braceEnd = j; break; } }
        }
        if (braceEnd === -1) continue;

        const msgJson = line.slice(braceStart, braceEnd + 1);
        const message = JSON.parse(msgJson);

        // Extract timestamp and sessionId via simple regex
        const tsMatch = line.match(/"timestamp"\s*:\s*(\d+)/);
        const sidMatch = line.match(/"sessionId"\s*:\s*"([^"]+)"/);

        entry = {
          type: typeMatch[1],
          message,
          timestamp: tsMatch ? parseInt(tsMatch[1]) : 0,
          sessionId: sidMatch ? sidMatch[1] : null,
        };
      }
    } catch { continue; }
    if (!entry || (entry.type !== 'user' && entry.type !== 'assistant')) continue;

    const extracted = extractContent(entry);
    if (!extracted) continue;
    totalMessages++;

    const chunks = chunkText(`[${extracted.role}] ${extracted.text}`);
    for (let i = 0; i < chunks.length; i++) {
      const r = insertChunk({
        agent,
        sourceType: 'conversation',
        sourceId: basename(file, '.jsonl'),
        sessionId: extracted.sessionId,
        content: chunks[i],
        timestamp: extracted.timestamp,
        metadata: { role: extracted.role, chunkIndex: i, totalChunks: chunks.length },
      });
      if (r.deduped) totalDeduped++; else { totalInserted++; fileInserted++; }
    }
  }

  manifest[key] = { mtime, indexed: Date.now(), chunks: fileInserted };
  filesProcessed++;
  if (fileInserted > 0) console.log(`  ${basename(file)}: ${fileInserted} chunks`);
}

for (const file of files) {
  await processFile(file);
}

saveManifest(manifest);
close();

console.log(`\nbackfill complete:`);
console.log(`  files processed: ${filesProcessed}/${files.length}`);
console.log(`  messages extracted: ${totalMessages}`);
console.log(`  chunks inserted: ${totalInserted}`);
console.log(`  chunks deduped: ${totalDeduped}`);
console.log(`  manifest saved to ${MANIFEST_PATH}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
