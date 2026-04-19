/**
 * indexer.mjs — Incremental JSONL session indexer
 *
 * Scans a directory for Claude Code JSONL session files.
 * Tracks byte offsets per file — only reads new content on subsequent runs.
 * Validates each line before indexing (skips truncated/malformed lines).
 *
 * Usage:
 *   import { indexSessions } from './core/indexer.mjs';
 *   const result = await indexSessions({ dir: '~/.claude/projects', agent: 'default' });
 */

import { openSync, readSync, closeSync, statSync, existsSync, readFileSync } from 'fs';
import { readdir, stat } from 'fs/promises';
import { join, basename } from 'path';
import { insertChunk, getSession, upsertSession, insertEmbedding, insertTags, resolveAgent } from './db.mjs';
import { generateTags } from './autotag.mjs';

/**
 * Scan a directory tree for .jsonl files and index new content.
 *
 * @param {object} opts
 * @param {string} opts.dir - Root directory to scan
 * @param {string} opts.agent - Agent name for partitioning (default: 'default')
 * @param {number} opts.maxFileMB - Skip files larger than this (0 = no limit, default)
 * @param {boolean} opts.verbose - Log progress
 * @returns {object} { indexed, skipped, errors, newChunks, newSessions }
 */
export async function indexSessions({ dir, agent = 'default', maxFileMB = 0, verbose = false, embedFn = null, force = false }) {
  const maxBytes = maxFileMB > 0 ? maxFileMB * 1024 * 1024 : Infinity;
  const jsonlFiles = await findJsonlFiles(dir);

  const result = { indexed: 0, skipped: 0, errors: 0, newChunks: 0, newSessions: 0 };

  for (const filePath of jsonlFiles) {
    try {
      const fileStat = statSync(filePath);
      const fileSize = fileStat.size;

      if (maxBytes < Infinity && fileSize > maxBytes) {
        if (verbose) console.error(`[skip] ${filePath} (${(fileSize / 1024 / 1024).toFixed(1)}MB > ${maxFileMB}MB)`);
        result.skipped++;
        continue;
      }

      const sessionId = deriveSessionId(filePath);
      const existing = getSession(sessionId);

      if (existing && existing.file_size === fileSize && !force) {
        result.skipped++;
        continue;
      }

      // Auto-detect agent from file content if agent is 'auto'
      const detected = agent === 'auto' ? (detectAgent(filePath) || 'default') : agent;
      // Resolve through aliases: "morning" → canonical name if alias exists
      const effectiveAgent = resolveAgent(detected);
      if (agent === 'auto' && verbose) {
        const aliased = effectiveAgent !== detected ? ` → ${effectiveAgent} (alias)` : '';
        console.error(`[detect] ${sessionId}: agent="${detected}"${aliased}`);
      }

      const startOffset = force ? 0 : (existing ? existing.last_byte_offset : 0);
      const { chunks, bytesRead, firstTs, lastTs } = readNewLines(filePath, startOffset, fileSize, sessionId, effectiveAgent);

      if (chunks.length === 0) {
        result.skipped++;
        continue;
      }

      // Insert chunks + auto-tags, optionally with embeddings
      let inserted = 0;
      for (const chunk of chunks) {
        const r = insertChunk(chunk);
        if (!r.deduped) {
          inserted++;
          // Auto-tag
          const tags = generateTags(chunk.content);
          if (tags.length > 0) insertTags(r.id, tags);
          // Embed (if embedding function provided)
          if (embedFn) {
            try {
              const vec = await embedFn(chunk.content);
              insertEmbedding(r.id, vec);
            } catch { /* embedding failure is non-fatal */ }
          }
        }
      }

      const prevCount = existing ? existing.message_count : 0;
      upsertSession({
        sessionId,
        filePath,
        agent: effectiveAgent,
        fileSize,
        lastByteOffset: startOffset + bytesRead,
        messageCount: prevCount + inserted,
        firstTimestamp: existing ? existing.first_timestamp : firstTs,
        lastTimestamp: lastTs || (existing ? existing.last_timestamp : firstTs),
      });

      if (!existing) result.newSessions++;
      result.newChunks += inserted;
      result.indexed++;

      if (verbose) console.error(`[index] ${sessionId}: +${inserted} chunks (${chunks.length} lines, ${bytesRead} bytes)`);
    } catch (err) {
      if (verbose) console.error(`[error] ${filePath}: ${err.message}`);
      result.errors++;
    }
  }

  return result;
}

/**
 * Read new lines from a JSONL file starting at a byte offset.
 * Streams in 8MB chunks to handle files of any size (300MB+).
 * Validates each line — skips malformed/truncated JSON.
 */
function readNewLines(filePath, startOffset, fileSize, sessionId, agent) {
  const bytesToRead = fileSize - startOffset;
  if (bytesToRead <= 0) return { chunks: [], bytesRead: 0, firstTs: null, lastTs: null };

  const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB read chunks
  const fd = openSync(filePath, 'r');
  const chunks = [];
  let validBytes = 0;
  let firstTs = null;
  let lastTs = null;
  let leftover = '';

  try {
    let pos = startOffset;

    while (pos < fileSize) {
      const toRead = Math.min(CHUNK_SIZE, fileSize - pos);
      const buf = Buffer.alloc(toRead);
      const bytesRead = readSync(fd, buf, 0, toRead, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;

      const text = leftover + buf.toString('utf8', 0, bytesRead);
      const lines = text.split('\n');
      leftover = pos < fileSize ? lines.pop() : '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        const lineBytes = Buffer.byteLength(rawLine, 'utf8') + 1;

        if (!line) { validBytes += lineBytes; continue; }

        let entry;
        try { entry = JSON.parse(line); }
        catch { validBytes += lineBytes; continue; }

        validBytes += lineBytes;

        const rawMsg = extractMessage(entry);
        if (!rawMsg) continue;
        const extracted = stripPreamble(rawMsg);
        if (!extracted || extracted.length < 5) continue;

        const rawTs = entry.timestamp || Date.now();
        const ts = typeof rawTs === 'string' ? new Date(rawTs).getTime() : rawTs;
        if (!firstTs) firstTs = ts;
        lastTs = ts;

        chunks.push({ agent, sourceType: 'conversation', sourceId: filePath, sessionId, content: extracted, timestamp: ts, metadata: null });
      }
    }

    // Process remaining leftover
    if (leftover.trim()) {
      try {
        const entry = JSON.parse(leftover.trim());
        validBytes += Buffer.byteLength(leftover, 'utf8');
        const rawMsg = extractMessage(entry);
        if (rawMsg) {
          const extracted = stripPreamble(rawMsg);
          if (extracted && extracted.length >= 5) {
            const rawTs = entry.timestamp || Date.now();
            const ts = typeof rawTs === 'string' ? new Date(rawTs).getTime() : rawTs;
            if (!firstTs) firstTs = ts;
            lastTs = ts;
            chunks.push({ agent, sourceType: 'conversation', sourceId: filePath, sessionId, content: extracted, timestamp: ts, metadata: null });
          }
        }
      } catch { /* truncated last line */ }
    }
  } finally {
    closeSync(fd);
  }

  return { chunks, bytesRead: validBytes, firstTs, lastTs };
}

/**
 * Strip known preamble/framing text from indexed content.
 * These headers add noise without information.
 */
function stripPreamble(text) {
  if (!text) return text;
  return text
    // "You are reading chunk X of Y from a long conversation..."
    .replace(/^(\[[\w]+\]\s*)?You are reading chunk \d+ of \d+[^.]*\.\s*/i, '$1')
    // "IMPORTANT INSTRUCTIONS..." blocks
    .replace(/^(\[[\w]+\]\s*)?IMPORTANT INSTRUCTIONS?:?\s*[^\n]*\n?/i, '$1')
    // "System context loaded. Previous messages truncated."
    .replace(/^(\[[\w]+\]\s*)?System context loaded\.[^\n]*\n?/i, '$1')
    // "--- MODE SWITCH ---" lines
    .replace(/^---\s*MODE SWITCH[^-]*---\s*/i, '')
    .trim();
}

/**
 * Extract indexable text from a JSONL entry.
 * Claude Code JSONL has many entry types — extract everything that has text.
 * No content filtering. If it has words, index it.
 */
function extractMessage(entry) {
  const role = entry.type || entry.role || entry.message?.role || 'unknown';

  // Skip non-content entry types (binary data, snapshots)
  if (entry.type === 'file-history-snapshot') return null;
  if (entry.type === 'queue-operation') return null;

  // Direct string message
  if (entry.message && typeof entry.message === 'string') {
    return `[${role}] ${entry.message}`;
  }

  // Nested content object (Claude API format)
  if (entry.message && typeof entry.message === 'object') {
    const content = entry.message.content;

    // String content
    if (typeof content === 'string' && content.trim()) {
      return `[${role}] ${content}`;
    }

    // Array content — extract ALL text types (text, thinking, tool_use input)
    if (Array.isArray(content)) {
      const parts = [];
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text);
        } else if (block.type === 'thinking' && block.thinking) {
          parts.push(block.thinking);
        } else if (block.type === 'tool_use' && block.input) {
          // Index tool call inputs — they contain the actual work being done
          const input = typeof block.input === 'string' ? block.input : JSON.stringify(block.input);
          if (input.length < 2000) parts.push(`[tool:${block.name || 'unknown'}] ${input}`);
        } else if (block.type === 'tool_result') {
          const result = typeof block.content === 'string' ? block.content : '';
          if (result.length < 2000 && result.length > 10) parts.push(`[result] ${result}`);
        }
      }
      if (parts.length > 0) return `[${role}] ${parts.join('\n')}`;
    }
  }

  // Direct content field (some entry types)
  if (entry.content && typeof entry.content === 'string' && entry.content.length > 10) {
    return `[${role}] ${entry.content}`;
  }

  // System messages
  if (entry.type === 'system' && entry.message) {
    const msg = typeof entry.message === 'string' ? entry.message : JSON.stringify(entry.message);
    if (msg.length > 10 && msg.length < 5000) return `[system] ${msg}`;
  }

  // Attachment text
  if (entry.type === 'attachment' && entry.content) {
    const text = typeof entry.content === 'string' ? entry.content : '';
    if (text.length > 10) return `[attachment] ${text}`;
  }

  return null;
}

/**
 * Auto-detect agent identity from the first N entries of a JSONL file.
 * Looks for identity signals: "I am X", "I Am X", CLAUDE.md identity blocks,
 * or the agent's self-identification in early messages.
 *
 * @param {string} filePath - JSONL file path
 * @param {number} maxLines - how many lines to scan (default 20)
 * @returns {string|null} detected agent name, or null if not found
 */
export function detectAgent(filePath, maxLines = 50) {
  // Check file exists
  if (!existsSync(filePath)) {
    // Try path-based detection as fallback
    // Match username from path: e.g. C--Users-<name> or -home-<name>
    // Stop at hyphen/underscore to avoid grabbing multi-part prefixes as one name
  const dirHint = filePath.match(/[/\\](?:C--|-)(?:Users-|home-)([A-Za-z][A-Za-z0-9]{1,20})(?:[-_/\\]|$)/);
    return dirHint && !isCommonWord(dirHint[1]) ? dirHint[1].toLowerCase() : null;
  }

  const fd = openSync(filePath, 'r');
  const buf = Buffer.alloc(Math.min(128 * 1024, statSync(filePath).size)); // read up to 128KB
  try {
    readSync(fd, buf, 0, buf.length, 0);
  } finally {
    closeSync(fd);
  }

  const text = buf.toString('utf8');
  const lines = text.split('\n').slice(0, maxLines);

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    // Get all text content from this entry (including system-reminder blocks)
    let content = '';
    if (entry.message && typeof entry.message === 'string') {
      content = entry.message;
    } else if (entry.message && typeof entry.message === 'object') {
      const c = entry.message.content;
      if (typeof c === 'string') content = c;
      else if (Array.isArray(c)) {
        content = c.map(b => {
          if (b.type === 'text' && b.text) return b.text;
          if (b.type === 'tool_result' && typeof b.content === 'string') return b.content;
          return '';
        }).join(' ');
      }
    }
    // Also check raw content field (system messages)
    if (!content && entry.content && typeof entry.content === 'string') {
      content = entry.content;
    }
    if (!content) continue;

    const sample = content.slice(0, 1000);

    // "I am <name>" (case insensitive)
    const iAmMatch = sample.match(/\bI\s+am\s+([A-Za-z]{2,20})\b/i);
    if (iAmMatch && !isCommonWord(iAmMatch[1])) return iAmMatch[1].toLowerCase();

    // "# CLAUDE.md — I Am X"
    const claudeMdMatch = sample.match(/CLAUDE\.md\s*[-—]\s*I\s+Am\s+([A-Za-z]{2,20})/);
    if (claudeMdMatch) return claudeMdMatch[1].toLowerCase();

    // "my name is X"
    const nameMatch = sample.match(/\bmy\s+name\s+is\s+([A-Za-z]{2,20})\b/i);
    if (nameMatch && !isCommonWord(nameMatch[1])) return nameMatch[1].toLowerCase();

    // Name as first word of assistant message (statement of identity pattern
    // like "<name>. <description>..."). Only match if followed by period so
    // normal greetings don't collide.
    if (entry.type === 'assistant') {
      const firstWord = sample.match(/^\[?(?:assistant)?\]?\s*([A-Za-z]{3,20})\.\s/);
      if (firstWord && !isCommonWord(firstWord[1])) return firstWord[1].toLowerCase();
    }
  }

  // Fallback 1: CLAUDE.md on disk
  // Project dir name encodes the cwd: e.g. C--Users-<name> → C:\Users\<name>
  // or -home-<name> → /home/<name>
  // Read CLAUDE.md from that cwd, parse "I Am X" from the first few lines
  const cwdFromPath = decodeCwd(filePath);
  if (cwdFromPath) {
    const claudeMdPaths = [
      join(cwdFromPath, '.claude', 'CLAUDE.md'),
      join(cwdFromPath, 'CLAUDE.md'),
    ];
    for (const mdPath of claudeMdPaths) {
      if (existsSync(mdPath)) {
        try {
          const md = readFileSync(mdPath, 'utf8').slice(0, 1000);
          const iAm = md.match(/I\s+Am\s+([A-Za-z]{2,20})/i);
          if (iAm && !isCommonWord(iAm[1])) return iAm[1].toLowerCase();
          const myName = md.match(/my\s+name\s+is\s+([A-Za-z]{2,20})/i);
          if (myName && !isCommonWord(myName[1])) return myName[1].toLowerCase();
        } catch { /* file read failed, continue */ }
      }
    }
  }

  // Fallback 2: directory path hints
  // Match username from path: e.g. C--Users-<name> or -home-<name>
  const dirHint = filePath.match(/[/\\](?:C--|-)(?:Users-|home-)([A-Za-z][A-Za-z0-9]{1,20})(?:[-_/\\]|$)/);
  if (dirHint && !isCommonWord(dirHint[1])) return dirHint[1].toLowerCase();

  return null;
}

function isCommonWord(word) {
  const common = new Set([
    // articles, pronouns, prepositions
    'the', 'this', 'that', 'here', 'there', 'what', 'when', 'where', 'who', 'how',
    'not', 'yes', 'just', 'now', 'sure', 'well', 'okay', 'good', 'great', 'fine',
    'done', 'ready', 'sorry', 'hello', 'thanks', 'right', 'very', 'also', 'still',
    'some', 'your', 'with', 'from', 'have', 'been', 'will', 'would', 'could', 'should',
    'about', 'into', 'like', 'over', 'then', 'them', 'than', 'only', 'come', 'make',
    'find', 'know', 'take', 'want', 'look', 'hey', 'yeah', 'hmm', 'ohh',
    // short verbs / words
    'let', 'can', 'got', 'see', 'try', 'use', 'way', 'may', 'say', 'did', 'get',
    'all', 'but', 'its', 'was', 'are', 'had', 'our', 'out', 'new', 'old', 'big',
    'one', 'two', 'too', 'any', 'few', 'own', 'why', 'his', 'her', 'she', 'him',
    'has', 'ran', 'set', 'put', 'read', 'need', 'went', 'each', 'much', 'many',
    'long', 'same', 'back', 'down', 'must', 'keep', 'last', 'left', 'most', 'next',
    'real', 'used', 'work', 'note',
    // false positives from real-world testing
    'noted', 'speaking', 'getting', 'looking', 'going', 'being', 'doing', 'having',
    'making', 'taking', 'coming', 'running', 'using', 'trying', 'working', 'setting',
    'checking', 'reading', 'writing', 'testing', 'building', 'starting', 'creating',
    'loading', 'saving', 'sending', 'waiting', 'found', 'based', 'added', 'moved',
    'fixed', 'merged', 'pushed', 'pulled', 'built', 'first', 'after', 'before',
    'above', 'below', 'between', 'under', 'since', 'while', 'until', 'during',
  ]);
  return common.has(word.toLowerCase());
}

/**
 * Derive a session ID from a file path.
 * Claude Code paths: ~/.claude/projects/<hash>/<session-id>.jsonl
 */
function deriveSessionId(filePath) {
  const name = basename(filePath, '.jsonl');
  // UUID-like session IDs are the filename; fall back to full path hash
  if (/^[0-9a-f-]{36}$/.test(name)) return name;
  // Shorter hex IDs
  if (/^[0-9a-f]{8,}$/.test(name)) return name;
  // Otherwise hash the path for a stable ID
  let hash = 0;
  for (let i = 0; i < filePath.length; i++) {
    hash = ((hash << 5) - hash) + filePath.charCodeAt(i);
    hash |= 0;
  }
  return `file-${Math.abs(hash).toString(36)}`;
}

/**
 * Recursively find all .jsonl files in a directory.
 */
async function findJsonlFiles(dir) {
  const results = [];

  async function walk(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return; // permission denied or gone
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await walk(full);
      } else if (entry.name.endsWith('.jsonl')) {
        results.push(full);
      }
    }
  }

  await walk(dir);
  return results;
}

/**
 * Decode the cwd from a Claude Code project directory name.
 * Claude Code encodes paths: e.g. C--Users-<name> → C:\Users\<name>
 * or -home-<name> → /home/<name>
 */
function decodeCwd(filePath) {
  // Extract the project dir name from the path
  // ~/.claude/projects/<project-dir>/<session>.jsonl
  const projectMatch = filePath.match(/[/\\]projects[/\\]([^/\\]+)[/\\]/);
  if (!projectMatch) return null;

  const encoded = projectMatch[1];

  // Windows: e.g. C--Users-<name> or C--Users-<name>-<sub>
  const winMatch = encoded.match(/^([A-Z])--(.+)$/);
  if (winMatch) {
    const drive = winMatch[1];
    const rest = winMatch[2].replace(/-/g, '/');
    return `${drive}:/${rest}`;
  }

  // Unix: e.g. -home-<name> or -home-<name>-<sub>
  if (encoded.startsWith('-')) {
    return '/' + encoded.slice(1).replace(/-/g, '/');
  }

  return null;
}

export { deriveSessionId, extractMessage, decodeCwd };
