/**
 * reimport.mjs — Backfill enrichment on existing indexed data
 *
 * Runs: fact extraction → tag refresh → session bookmark materialization → KG materialization.
 * Idempotent — skips already-processed chunks, safe to re-run.
 *
 * Used by: scripts/reimport.mjs (CLI) and mcp-server.mjs (memory_reimport tool).
 */

import { getDb, insertChunk, insertFact, insertPreferenceSignal, upsertBookmark, insertTags, insertEmbedding, materializeTopicRelations, materializeDirectoryRelations } from './db.mjs';
import { extractFacts } from './facts.mjs';
import { extractPreferences } from './preferences.mjs';
import { generateTags } from './autotag.mjs';

/**
 * Run the full reimport pipeline.
 * @param {object} opts
 * @param {string} opts.agent - Filter by agent (null = all)
 * @param {string} opts.steps - "all", "facts", "preferences", "tags", "bookmarks", "kg", "embeddings"
 * @param {boolean} opts.dryRun - Preview without writing
 * @param {function} opts.log - Log function (default: console.error)
 * @returns {Promise<object>} Results per step
 */
export async function runReimport({ agent = null, steps = 'all', dryRun = false, log = (msg) => console.error(`[reimport] ${msg}`) } = {}) {
  const db = getDb();
  const results = {};

  if (steps === 'all' || steps === 'facts') {
    results.facts = backfillFacts(db, agent, dryRun, log);
  }

  if (steps === 'all' || steps === 'preferences') {
    results.preferences = backfillPreferences(db, agent, dryRun, log);
  }

  if (steps === 'all' || steps === 'tags') {
    results.tags = backfillTags(db, agent, dryRun, log);
  }

  if (steps === 'all' || steps === 'bookmarks') {
    results.bookmarks = backfillBookmarks(db, agent, dryRun, log);
  }

  if (steps === 'all' || steps === 'kg') {
    results.kg = backfillKG(dryRun, log);
  }

  // Embeddings are opt-in from "all" since they're slow (model load + per-chunk CPU inference).
  // Run explicitly via steps="embeddings" or steps="all+embeddings".
  if (steps === 'embeddings' || steps === 'all+embeddings') {
    results.embeddings = await backfillEmbeddings(db, agent, dryRun, log);
  }

  return results;
}

/**
 * Backfill vector embeddings for chunks missing them.
 *
 * Uses the default all-MiniLM-L6-v2 (384d, 22MB model, CPU-only).
 * Idempotent — only processes chunks not yet in chunks_vec.
 *
 * This is the slowest reimport step by far: each chunk takes ~10-50ms on
 * consumer CPU. For a 10K-chunk corpus expect 2-10 minutes. Safe to
 * interrupt and resume (skipped chunks stay skipped).
 */
async function backfillEmbeddings(db, agent, dryRun, log) {
  log('embedding backfill...');

  let sql = `
    SELECT c.id, c.content
    FROM chunks c
    WHERE c.id NOT IN (SELECT rowid FROM chunks_vec)
      AND length(c.content) > 10
  `;
  const params = [];
  if (agent) { sql += ' AND c.agent = ?'; params.push(agent); }
  sql += ' ORDER BY c.id ASC';

  const chunks = db.prepare(sql).all(...params);
  log(`  ${chunks.length} chunks without embeddings`);

  if (dryRun || chunks.length === 0) {
    log(`  (${dryRun ? 'dry run' : 'nothing to do'})`);
    return { scanned: chunks.length, embedded: 0 };
  }

  const { embed } = await import('./embeddings.mjs');

  // Warm the model with a dummy call so the first real embed doesn't
  // include the ~3s model-load time in per-chunk averaging.
  log(`  loading embedding model...`);
  await embed('warmup');
  log(`  model loaded, embedding ${chunks.length} chunks...`);

  let embedded = 0;
  const startTime = Date.now();
  const progressEvery = Math.max(100, Math.floor(chunks.length / 20));

  for (const chunk of chunks) {
    try {
      const vec = await embed(chunk.content);
      insertEmbedding(chunk.id, vec);
      embedded++;
      if (embedded % progressEvery === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = embedded / elapsed;
        const eta = Math.round((chunks.length - embedded) / rate);
        log(`  ${embedded}/${chunks.length} (${rate.toFixed(1)}/s, ETA ${eta}s)`);
      }
    } catch (err) {
      // Non-fatal — skip this chunk, keep going
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;
  log(`  ${embedded} chunks embedded in ${elapsed.toFixed(0)}s`);
  return { scanned: chunks.length, embedded, elapsedSec: Math.round(elapsed) };
}

function backfillFacts(db, agent, dryRun, log) {
  log('fact extraction...');

  // Find user chunks that don't have facts extracted yet
  let sql = `
    SELECT c.id, c.agent, c.session_id, c.content, c.timestamp
    FROM chunks c
    WHERE c.source_type = 'conversation'
      AND c.content LIKE '[user]%'
      AND c.id NOT IN (SELECT source_chunk_id FROM facts WHERE source_chunk_id IS NOT NULL)
  `;
  const params = [];
  if (agent) { sql += ' AND c.agent = ?'; params.push(agent); }
  sql += ' ORDER BY c.timestamp ASC';

  const chunks = db.prepare(sql).all(...params);
  log(`  ${chunks.length} user chunks without fact extraction`);

  let extracted = 0;
  let factCount = 0;

  for (const chunk of chunks) {
    const facts = extractFacts(chunk.content);
    if (facts.length === 0) continue;

    extracted++;
    factCount += facts.length;

    if (dryRun) continue;

    // Insert into dedicated facts table, NOT chunks table
    for (const f of facts) {
      insertFact({
        agent: chunk.agent,
        predicate: f.predicate,
        object: f.object,
        sourceChunkId: chunk.id,
        sessionId: chunk.session_id,
        timestamp: chunk.timestamp,
      });
    }
  }

  log(`  ${extracted} chunks → ${factCount} facts${dryRun ? ' (dry run)' : ''}`);
  return { scanned: chunks.length, extracted, facts: factCount };
}

function backfillPreferences(db, agent, dryRun, log) {
  log('preference signal extraction...');

  // Find user chunks not yet processed for preferences
  let sql = `
    SELECT c.id, c.agent, c.session_id, c.content, c.timestamp
    FROM chunks c
    WHERE c.source_type = 'conversation'
      AND c.content LIKE '[user]%'
      AND c.id NOT IN (SELECT chunk_id FROM preference_signals WHERE chunk_id IS NOT NULL)
  `;
  const params = [];
  if (agent) { sql += ' AND c.agent = ?'; params.push(agent); }
  sql += ' ORDER BY c.timestamp ASC';

  const chunks = db.prepare(sql).all(...params);
  log(`  ${chunks.length} user chunks without preference extraction`);

  let extracted = 0;
  let signalCount = 0;

  for (const chunk of chunks) {
    const signals = extractPreferences(chunk.content);
    if (signals.length === 0) continue;

    extracted++;
    signalCount += signals.length;

    if (dryRun) continue;

    for (const s of signals) {
      insertPreferenceSignal({
        agent: chunk.agent,
        domain: s.domain,
        subject: s.subject,
        context: s.context,
        sentiment: s.sentiment,
        rawText: s.rawText,
        sessionId: chunk.session_id,
        chunkId: chunk.id,
      });
    }
  }

  log(`  ${extracted} chunks → ${signalCount} preference signals${dryRun ? ' (dry run)' : ''}`);
  return { scanned: chunks.length, extracted, signals: signalCount };
}

function backfillTags(db, agent, dryRun, log) {
  log('tag refresh...');

  let sql = `
    SELECT c.id, c.content
    FROM chunks c
    WHERE c.id NOT IN (SELECT DISTINCT chunk_id FROM tags)
      AND c.source_type IN ('conversation', 'memory-chunk', 'identity')
      AND length(c.content) > 20
  `;
  const params = [];
  if (agent) { sql += ' AND c.agent = ?'; params.push(agent); }
  sql += ' LIMIT 50000';

  const chunks = db.prepare(sql).all(...params);
  log(`  ${chunks.length} chunks without tags`);

  let tagged = 0;
  if (!dryRun) {
    for (const chunk of chunks) {
      const tags = generateTags(chunk.content);
      if (tags.length > 0) {
        insertTags(chunk.id, tags);
        tagged++;
      }
    }
  }

  log(`  ${tagged} chunks tagged${dryRun ? ' (dry run)' : ''}`);
  return { untagged: chunks.length, tagged };
}

function backfillBookmarks(db, agent, dryRun, log) {
  log('session bookmark materialization...');

  // Find sessions missing bookmarks. With multi-dir bookmarks, a session
  // may have SOME bookmarks but be missing bookmarks for directories it touched.
  // For simplicity, only process sessions with zero bookmarks (full backfill).
  let sql = `
    SELECT s.session_id, s.agent, s.file_path, s.first_timestamp, s.last_timestamp, s.message_count
    FROM sessions s
    WHERE s.session_id NOT IN (SELECT session_id FROM session_bookmarks)
  `;
  const params = [];
  if (agent) { sql += ' AND s.agent = ?'; params.push(agent); }

  const sessions = db.prepare(sql).all(...params);
  log(`  ${sessions.length} sessions without bookmarks`);

  let bookmarked = 0;

  for (const session of sessions) {
    const sessionTags = db.prepare(`
      SELECT DISTINCT t.tag
      FROM tags t JOIN chunks c ON c.id = t.chunk_id
      WHERE c.session_id = ? AND c.agent = ?
      ORDER BY t.tag
    `).all(session.session_id, session.agent).map(r => r.tag);

    // Extract ALL file paths from tool calls
    const toolChunks = db.prepare(`
      SELECT content FROM chunks
      WHERE session_id = ? AND source_type = 'conversation'
        AND content LIKE '%[tool:%]%'
      LIMIT 200
    `).all(session.session_id);

    const allFiles = extractFilePaths(toolChunks);

    // Group files by directory, detect touched directories
    const launchDir = extractDirectory(session.file_path);
    const touchedDirs = extractTouchedDirectories(allFiles, launchDir);

    // Summary from first user messages
    const firstChunks = db.prepare(`
      SELECT content FROM chunks WHERE session_id = ? AND agent = ?
        AND source_type = 'conversation' AND content LIKE '[user]%'
      ORDER BY timestamp ASC LIMIT 3
    `).all(session.session_id, session.agent);

    const summary = firstChunks
      .map(c => c.content.replace(/^\[user\]\s*/, '').slice(0, 100))
      .join(' | ')
      .slice(0, 300) || null;

    const chunkCount = db.prepare(
      'SELECT COUNT(*) as c FROM chunks WHERE session_id = ? AND agent = ?'
    ).get(session.session_id, session.agent)?.c || 0;

    if (!dryRun) {
      // Create a bookmark for each distinct directory touched
      for (const { directory, files } of touchedDirs) {
        upsertBookmark({
          sessionId: session.session_id,
          agent: session.agent,
          directory,
          projectName: null,
          startedAt: session.first_timestamp,
          endedAt: session.last_timestamp,
          summary,
          filesTouched: files,
          chunksIndexed: chunkCount,
          tags: sessionTags,
        });
        bookmarked++;
      }

      // If no directories detected, still create one bookmark with null directory
      if (touchedDirs.length === 0) {
        upsertBookmark({
          sessionId: session.session_id,
          agent: session.agent,
          directory: launchDir,
          projectName: null,
          startedAt: session.first_timestamp,
          endedAt: session.last_timestamp,
          summary,
          filesTouched: [...allFiles],
          chunksIndexed: chunkCount,
          tags: sessionTags,
        });
        bookmarked++;
      }
    }
  }

  log(`  ${bookmarked} bookmarks created${dryRun ? ' (dry run)' : ''}`);
  return { unbookmarked: sessions.length, bookmarked };
}

/**
 * Extract file paths from tool call chunks.
 */
function extractFilePaths(toolChunks) {
  const files = new Set();
  for (const chunk of toolChunks) {
    const matches = chunk.content.match(/(?:file_path|path|filename)['":\s]+([^\s'"}\],]+)/g);
    if (matches) {
      for (const m of matches) {
        const path = m.replace(/.*?['":\s]+/, '').replace(/['"}\],].*/, '');
        if (path.length > 3 && path.length < 200) files.add(path);
      }
    }
  }
  return files;
}

// Directories to filter out of touched-directory detection
const NOISE_DIRS = new Set([
  '.claude', 'node_modules', '.git', '__pycache__', 'build', 'dist',
  '.next', '.cache', '.vscode', '.idea', 'coverage', '.nyc_output',
  'target', 'bin', 'obj', '.gradle', '.terraform',
]);

/**
 * Extract distinct meaningful directories from a set of file paths.
 * Groups files by their project-level directory (depth ~3-4 from root).
 * Filters noise directories.
 *
 * @param {Set<string>} files - All file paths touched in the session
 * @param {string|null} launchDir - The session's launch directory
 * @returns {Array<{directory: string, files: string[]}>}
 */
function extractTouchedDirectories(files, launchDir) {
  const dirFiles = new Map(); // directory → [files]

  for (const file of files) {
    const normalized = file.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);

    // Skip noise directories
    if (parts.some(p => NOISE_DIRS.has(p))) continue;

    // Find a meaningful project-level directory.
    // Heuristic: walk up from the file until we find a directory that looks
    // like a project root (contains src/, lib/, core/, or is 2-4 levels from root)
    const dir = findProjectDir(parts);
    if (!dir) continue;

    if (!dirFiles.has(dir)) dirFiles.set(dir, []);
    dirFiles.get(dir).push(file);
  }

  // Always include the launch directory if we have one
  if (launchDir && !dirFiles.has(launchDir)) {
    dirFiles.set(launchDir, []);
  }

  return Array.from(dirFiles.entries()).map(([directory, files]) => ({ directory, files }));
}

/**
 * Find the project-level directory from path parts.
 * Returns the directory that's likely a project root.
 */
function findProjectDir(parts) {
  if (parts.length < 2) return null;

  // For absolute paths like /home/user/projects/myapp/src/file.js
  // We want /home/user/projects/myapp
  // Heuristic: the directory before common source dirs (src, lib, core, scripts, etc.)
  const sourceDirs = new Set(['src', 'lib', 'core', 'scripts', 'cmd', 'pkg', 'internal', 'app', 'test', 'tests', 'spec']);

  for (let i = parts.length - 1; i >= 1; i--) {
    if (sourceDirs.has(parts[i])) {
      return '/' + parts.slice(0, i).join('/');
    }
  }

  // No source dir found — use parent of the file (depth 2+ from root)
  if (parts.length >= 3) {
    return '/' + parts.slice(0, -1).join('/');
  }

  return '/' + parts.slice(0, Math.max(2, parts.length - 1)).join('/');
}

/**
 * Extract the working directory from a session file path.
 * Claude Code encodes paths: e.g. C--Users-<name> → C:/Users/<name>
 *
 * Known limitation: hyphenated folder names (my-project) decode incorrectly
 * to my/project. Claude's encoding uses - as path separator with no escaping.
 * This is the same limitation as indexer.mjs decodeCwd().
 */
function extractDirectory(filePath) {
  if (!filePath) return null;
  const projectMatch = filePath.match(/[/\\]projects[/\\]([^/\\]+)[/\\]/);
  if (!projectMatch) return null;

  const encoded = projectMatch[1];

  // Windows: e.g. C--Users-<name> (double dash = drive letter separator)
  const winMatch = encoded.match(/^([A-Z])--(.+)$/);
  if (winMatch) return `${winMatch[1]}:/${winMatch[2].replace(/-/g, '/')}`;

  // Unix: e.g. -home-<name>-<project>
  if (encoded.startsWith('-')) return '/' + encoded.slice(1).replace(/-/g, '/');

  return null;
}

function backfillKG(dryRun, log) {
  log('KG materialization...');

  if (dryRun) {
    log('  (dry run — skipping)');
    return { topics: 0 };
  }

  const topicResult = materializeTopicRelations();
  log(`  topic relations: ${topicResult.edges} edges`);

  materializeDirectoryRelations();
  log(`  directory relations: materialized`);

  return { topics: topicResult.edges };
}
