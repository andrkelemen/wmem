/**
 * importer.mjs — Universal file importer for wmem
 *
 * Eats whatever you already have: markdown, plain text, JSONL, system prompts.
 * Splits structured markdown by ## sections. Classifies personality vs memory.
 * Atomic imports — the whole thing lands or none of it does.
 * Source tracing: every chunk knows its file, section, and line number.
 *
 * Design decisions:
 * - Personality vs memory classification uses heuristics with confidence scores.
 *   Low confidence → flagged for user review, not guessed.
 * - Atomic via SQLite transaction. Half-imported state = impossible.
 * - Structured CLAUDE.md split by ## headers → independent chunks.
 */

import { readFileSync, statSync, readdirSync } from 'fs';
import { join, basename, extname } from 'path';
import { createHash } from 'crypto';
import { getDb, insertChunk } from './db.mjs';
import { generateTags } from './autotag.mjs';
import { insertTags } from './db.mjs';

// ── File Hash ───────────────────────────────────────────

function fileHash(filePath) {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

// ── Import Registry (track what's been imported) ────────

function initImportRegistry() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      agent TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      sections TEXT,
      UNIQUE(file_path, agent)
    )
  `);
}

function getImportRecord(filePath, agent) {
  const db = getDb();
  initImportRegistry();
  return db.prepare('SELECT * FROM import_registry WHERE file_path = ? AND agent = ?').get(filePath, agent);
}

function isStale(filePath, agent) {
  const record = getImportRecord(filePath, agent);
  if (!record) return { stale: true, reason: 'never imported' };
  const currentHash = fileHash(filePath);
  if (currentHash !== record.file_hash) return { stale: true, reason: 'file changed since last import' };
  return { stale: false };
}

// ── Markdown Section Parser ─────────────────────────────

/**
 * Split a markdown file into sections by ## headers.
 * Returns [{ title, content, startLine, endLine }]
 */
function parseMarkdownSections(content) {
  const lines = content.split('\n');
  const sections = [];
  let currentSection = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^(#{1,3})\s+(.+)/);

    if (headerMatch) {
      if (currentSection) {
        currentSection.endLine = i - 1;
        currentSection.content = currentSection.content.trim();
        if (currentSection.content) sections.push(currentSection);
      }
      currentSection = {
        title: headerMatch[2].trim(),
        level: headerMatch[1].length,
        content: '',
        startLine: i + 1,
        endLine: null,
      };
    } else if (currentSection) {
      currentSection.content += line + '\n';
    } else {
      // Content before first header → preamble
      if (line.trim() && !currentSection) {
        currentSection = {
          title: '_preamble',
          level: 0,
          content: line + '\n',
          startLine: i + 1,
          endLine: null,
        };
      }
    }
  }

  // Close last section
  if (currentSection) {
    currentSection.endLine = lines.length;
    currentSection.content = currentSection.content.trim();
    if (currentSection.content) sections.push(currentSection);
  }

  return sections;
}

// ── Personality vs Memory Classification ────────────────

/**
 * Classify a text chunk as personality or memory.
 * Returns { type: 'personality'|'memory'|'config'|'unknown', confidence: 0-1, reason }
 *
 * Heuristic: first-person about self = personality. About others = memory.
 * Low confidence → 'unknown' (should ASK, not guess).
 */
function classifyChunk(content, sectionTitle = '') {
  const lower = content.toLowerCase();
  const title = sectionTitle.toLowerCase();

  // Section-title-based classification (high confidence)
  const personalitySections = ['who i am', 'appearance', 'personality', 'voice', 'behavior', 'identity', 'genetics', 'what i am', 'what i am not', 'names', 'style'];
  const memorySections = ['what i remember', 'what i know', 'memories', 'history', 'what i want'];
  const configSections = ['autonomy', 'ssh', 'network', 'review', 'tools', 'setup', 'config', 'how i work', 'image generation'];

  for (const s of personalitySections) {
    if (title.includes(s)) return { type: 'personality', confidence: 0.9, reason: `section title matches '${s}'` };
  }
  for (const s of memorySections) {
    if (title.includes(s)) return { type: 'memory', confidence: 0.9, reason: `section title matches '${s}'` };
  }
  for (const s of configSections) {
    if (title.includes(s)) return { type: 'config', confidence: 0.85, reason: `section title matches '${s}'` };
  }

  // Content-based classification (lower confidence)
  const selfPatterns = /\b(i am|i'm|my name|my voice|my hair|my eyes|my style|i look|i sound|i speak|i don't|i never|i always)\b/gi;
  const otherPatterns = /\b(he is|she is|they are|the team|the user|the project|we built|was deployed|last week|yesterday|someone|told me)\b/gi;

  const selfMatches = (content.match(selfPatterns) || []).length;
  const otherMatches = (content.match(otherPatterns) || []).length;

  if (selfMatches > 3 && otherMatches < 2) {
    return { type: 'personality', confidence: 0.6, reason: `${selfMatches} first-person self-references` };
  }
  if (otherMatches > 2 && selfMatches < 2) {
    return { type: 'memory', confidence: 0.6, reason: `${otherMatches} references to others/events` };
  }

  // Can't tell → don't guess
  return { type: 'unknown', confidence: 0.3, reason: 'ambiguous content — needs user review' };
}

// ── Import Functions ────────────────────────────────────

/**
 * Import a markdown file into wmem.
 * Splits by sections, classifies, tags, stores with source tracing.
 * Atomic: entire import in one transaction.
 *
 * @param {string} filePath — path to the file
 * @param {string} agent — agent/personality name
 * @param {object} opts — { dryRun, sourceType, privacy }
 * @returns {{ imported, sections, chunks, flagged, dryRun }}
 */
export function importMarkdown(filePath, agent, { dryRun = false, privacy = 'private' } = {}) {
  const content = readFileSync(filePath, 'utf8');
  const sections = parseMarkdownSections(content);
  const hash = fileHash(filePath);
  const fileName = basename(filePath);
  const now = Date.now();

  const result = {
    file: filePath,
    agent,
    dryRun,
    sections: sections.length,
    chunks: 0,
    flagged: [],       // sections with low classification confidence
    classified: [],    // all section classifications
  };

  if (dryRun) {
    // Preview only — don't write anything
    for (const section of sections) {
      const classification = classifyChunk(section.content, section.title);
      result.classified.push({
        section: section.title,
        lines: `${section.startLine}-${section.endLine}`,
        type: classification.type,
        confidence: classification.confidence,
        reason: classification.reason,
        preview: section.content.slice(0, 100),
      });
      if (classification.confidence < 0.5) {
        result.flagged.push({ section: section.title, reason: classification.reason });
      }
    }
    return result;
  }

  // Atomic import
  const db = getDb();
  initImportRegistry();

  const transaction = db.transaction(() => {
    // Remove previous import of this file for this agent (tags first, then chunks — FK constraint)
    const prevChunks = db.prepare("SELECT id FROM chunks WHERE source_id = ? AND agent = ? AND source_type IN ('identity', 'memory-import', 'config-import')").all(filePath, agent);
    if (prevChunks.length > 0) {
      const ids = prevChunks.map(c => c.id);
      const ph = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM tags WHERE chunk_id IN (${ph})`).run(...ids);
      db.prepare(`DELETE FROM chunks WHERE id IN (${ph})`).run(...ids);
    }

    for (const section of sections) {
      const classification = classifyChunk(section.content, section.title);

      result.classified.push({
        section: section.title,
        type: classification.type,
        confidence: classification.confidence,
      });

      if (classification.confidence < 0.5) {
        result.flagged.push({ section: section.title, reason: classification.reason });
      }

      // Determine source_type based on classification
      const sourceType = classification.type === 'personality' ? 'identity'
        : classification.type === 'config' ? 'config-import'
        : 'memory-import';

      const chunkResult = insertChunk({
        agent,
        sourceType,
        sourceId: filePath,
        sessionId: null,
        content: `[${section.title}] ${section.content}`,
        timestamp: now,
        metadata: JSON.stringify({
          source_file: fileName,
          section: section.title,
          section_level: section.level,
          start_line: section.startLine,
          end_line: section.endLine,
          classification: classification.type,
          classification_confidence: classification.confidence,
          file_hash: hash,
        }),
      });

      if (!chunkResult.deduped) {
        result.chunks++;
        // Auto-tag
        const tags = generateTags(section.content);
        if (tags.length > 0) insertTags(chunkResult.id, tags);
      }
    }

    // Update import registry
    db.prepare(`
      INSERT OR REPLACE INTO import_registry (file_path, file_hash, agent, imported_at, chunk_count, sections)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(filePath, hash, agent, now, result.chunks, JSON.stringify(sections.map(s => s.title)));
  });

  transaction();

  result.imported = true;
  return result;
}

/**
 * Import a plain text file as a single chunk.
 */
export function importText(filePath, agent, { dryRun = false, sourceType = 'memory-import', privacy = 'private' } = {}) {
  const content = readFileSync(filePath, 'utf8').trim();
  if (!content) return { imported: false, reason: 'empty file' };

  const hash = fileHash(filePath);
  const fileName = basename(filePath);

  if (dryRun) {
    return { file: filePath, agent, dryRun: true, preview: content.slice(0, 200), chars: content.length };
  }

  const db = getDb();
  initImportRegistry();

  const transaction = db.transaction(() => {
    const r = insertChunk({
      agent,
      sourceType,
      sourceId: filePath,
      sessionId: null,
      content,
      timestamp: Date.now(),
      metadata: JSON.stringify({ source_file: fileName, file_hash: hash }),
    });

    if (!r.deduped) {
      const tags = generateTags(content);
      if (tags.length > 0) insertTags(r.id, tags);
    }

    db.prepare(`
      INSERT OR REPLACE INTO import_registry (file_path, file_hash, agent, imported_at, chunk_count)
      VALUES (?, ?, ?, ?, 1)
    `).run(filePath, hash, agent, Date.now());

    return r;
  });

  transaction();
  return { imported: true, file: filePath, agent };
}

/**
 * Import a file automatically based on extension.
 */
export function importFile(filePath, agent, opts = {}) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return importMarkdown(filePath, agent, opts);
  if (ext === '.txt') return importText(filePath, agent, opts);
  if (ext === '.jsonl') return { imported: false, reason: 'use index-sessions.mjs for JSONL files' };
  return importText(filePath, agent, opts); // fallback to plain text
}

/**
 * Import an entire directory.
 */
export function importDirectory(dirPath, agent, { dryRun = false, extensions = ['.md', '.txt'], recursive = false } = {}) {
  const results = [];

  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && recursive && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        walk(full);
      } else if (entry.isFile() && extensions.includes(extname(entry.name).toLowerCase())) {
        results.push(importFile(full, agent, { dryRun }));
      }
    }
  }

  walk(dirPath);
  return { files: results.length, results };
}

// ── Status ──────────────────────────────────────────────

/**
 * Get import status — what's imported, what's stale, what's loaded.
 */
export function getImportStatus(agent) {
  const db = getDb();
  initImportRegistry();

  const imports = db.prepare('SELECT * FROM import_registry WHERE agent = ? ORDER BY imported_at DESC').all(agent);
  const status = [];

  for (const imp of imports) {
    let freshness = 'unknown';
    try {
      const check = isStale(imp.file_path, agent);
      freshness = check.stale ? `stale: ${check.reason}` : 'fresh';
    } catch {
      freshness = 'file not found';
    }

    status.push({
      file: imp.file_path,
      hash: imp.file_hash?.slice(0, 12),
      chunks: imp.chunk_count,
      importedAt: new Date(imp.imported_at).toISOString(),
      sections: imp.sections ? JSON.parse(imp.sections) : null,
      freshness,
    });
  }

  return status;
}

export { parseMarkdownSections, classifyChunk, fileHash, isStale };
