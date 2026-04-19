/**
 * personality.mjs — Personality management for wmem
 *
 * A personality is a complete agent identity: name, voice, system prompt,
 * capabilities, and memory partition. Switching personality changes how
 * the agent behaves and what it remembers.
 *
 * Each personality gets its own memory partition (agent field in DB).
 * Switching is instant — the session-start hook loads the active
 * personality's system prompt + L1 into context.
 *
 * Storage: personalities table in the same SQLite DB.
 */

import { getDb } from './db.mjs';

// ── Schema ──────────────────────────────────────────

function initTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS personalities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT,
      description TEXT,
      system_prompt TEXT,
      voice TEXT,
      capabilities TEXT,
      restrictions TEXT,
      born TEXT,
      avatar TEXT,
      metadata TEXT,
      active INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_personalities_active ON personalities(active)`);

  // Personality files — named documents per personality (identity, preferences, notes)
  db.exec(`
    CREATE TABLE IF NOT EXISTS personality_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      personality TEXT NOT NULL,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      always_load INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER,
      UNIQUE(personality, filename)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pfiles_personality ON personality_files(personality)`);
}

// ── CRUD ──────────────────────────────────────────

/**
 * Create a new personality.
 *
 * @param {object} opts
 * @param {string} opts.name - Unique identifier (used as agent partition key)
 * @param {string} opts.displayName - Human-readable name
 * @param {string} opts.description - One-line description
 * @param {string} opts.systemPrompt - Injected into session context
 * @param {string} opts.voice - Tone/style description
 * @param {string[]} opts.capabilities - What this personality can do
 * @param {string[]} opts.restrictions - What it shouldn't do
 * @param {string} opts.born - ISO date (for temporal anchor)
 * @param {string} opts.avatar - Path or URL to avatar image
 */
export function createPersonality({
  name, displayName, description, systemPrompt, voice,
  capabilities = [], restrictions = [], born, avatar, metadata
}) {
  const db = getDb();
  initTable();
  const now = Date.now();

  db.prepare(`
    INSERT INTO personalities (name, display_name, description, system_prompt, voice,
      capabilities, restrictions, born, avatar, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    displayName || name,
    description || '',
    systemPrompt || '',
    voice || '',
    JSON.stringify(capabilities),
    JSON.stringify(restrictions),
    born || null,
    avatar || null,
    metadata ? JSON.stringify(metadata) : null,
    now, now
  );

  return { created: true, name };
}

/**
 * Update an existing personality.
 */
export function updatePersonality(name, updates) {
  const db = getDb();
  initTable();

  const fields = [];
  const values = [];

  if (updates.displayName !== undefined) { fields.push('display_name = ?'); values.push(updates.displayName); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.systemPrompt !== undefined) { fields.push('system_prompt = ?'); values.push(updates.systemPrompt); }
  if (updates.voice !== undefined) { fields.push('voice = ?'); values.push(updates.voice); }
  if (updates.capabilities !== undefined) { fields.push('capabilities = ?'); values.push(JSON.stringify(updates.capabilities)); }
  if (updates.restrictions !== undefined) { fields.push('restrictions = ?'); values.push(JSON.stringify(updates.restrictions)); }
  if (updates.born !== undefined) { fields.push('born = ?'); values.push(updates.born); }
  if (updates.avatar !== undefined) { fields.push('avatar = ?'); values.push(updates.avatar); }
  if (updates.metadata !== undefined) { fields.push('metadata = ?'); values.push(JSON.stringify(updates.metadata)); }

  if (fields.length === 0) return { updated: false, reason: 'no fields to update' };

  fields.push('updated_at = ?');
  values.push(Date.now());
  values.push(name);

  db.prepare(`UPDATE personalities SET ${fields.join(', ')} WHERE name = ?`).run(...values);
  return { updated: true, name };
}

/**
 * Get a personality by name.
 */
export function getPersonality(name) {
  const db = getDb();
  initTable();
  const p = db.prepare('SELECT * FROM personalities WHERE name = ?').get(name);
  return p ? deserialize(p) : null;
}

/**
 * List all personalities.
 */
export function listPersonalities() {
  const db = getDb();
  initTable();
  return db.prepare('SELECT * FROM personalities ORDER BY active DESC, name ASC').all().map(deserialize);
}

/**
 * Delete a personality. Does NOT delete its memories — those stay in the DB
 * partitioned by the agent name. You can always recreate the personality
 * and the memories will still be there.
 */
export function deletePersonality(name) {
  const db = getDb();
  initTable();
  const result = db.prepare('DELETE FROM personalities WHERE name = ?').run(name);
  return { deleted: result.changes > 0, name };
}

// ── Activation ──────────────────────────────────────

/**
 * Set the active personality. Only one can be active at a time.
 * The session-start hook reads the active personality to know
 * which system prompt and memory partition to load.
 */
export function activatePersonality(name) {
  const db = getDb();
  initTable();

  const exists = db.prepare('SELECT id FROM personalities WHERE name = ?').get(name);
  if (!exists) return { activated: false, reason: 'personality not found' };

  db.prepare('UPDATE personalities SET active = 0').run();
  db.prepare('UPDATE personalities SET active = 1 WHERE name = ?').run(name);
  return { activated: true, name };
}

/**
 * Get the currently active personality.
 */
export function getActivePersonality() {
  const db = getDb();
  initTable();
  const p = db.prepare('SELECT * FROM personalities WHERE active = 1').get();
  return p ? deserialize(p) : null;
}

// ── Personality Files ──────────────────────────────────

/**
 * Set a personality file (create or update).
 */
export function setPersonalityFile(personality, filename, content, alwaysLoad = false) {
  const db = getDb();
  initTable();
  const now = Date.now();
  const existing = db.prepare('SELECT id FROM personality_files WHERE personality = ? AND filename = ?').get(personality, filename);
  if (existing) {
    db.prepare('UPDATE personality_files SET content = ?, always_load = ?, updated_at = ? WHERE id = ?')
      .run(content, alwaysLoad ? 1 : 0, now, existing.id);
    return { updated: true, filename };
  }
  db.prepare('INSERT INTO personality_files (personality, filename, content, always_load, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(personality, filename, content, alwaysLoad ? 1 : 0, now);
  return { created: true, filename };
}

/**
 * Get a specific personality file.
 */
export function getPersonalityFile(personality, filename) {
  const db = getDb();
  initTable();
  return db.prepare('SELECT * FROM personality_files WHERE personality = ? AND filename = ?').get(personality, filename);
}

/**
 * List all files for a personality.
 */
export function listPersonalityFiles(personality) {
  const db = getDb();
  initTable();
  return db.prepare('SELECT filename, always_load, updated_at, LENGTH(content) as size FROM personality_files WHERE personality = ? ORDER BY filename').all(personality);
}

/**
 * Delete a personality file.
 */
export function deletePersonalityFile(personality, filename) {
  const db = getDb();
  initTable();
  const result = db.prepare('DELETE FROM personality_files WHERE personality = ? AND filename = ?').run(personality, filename);
  return { deleted: result.changes > 0 };
}

/**
 * Get all always_load files for a personality (for L1 injection).
 */
export function getAlwaysLoadFiles(personality) {
  const db = getDb();
  initTable();
  return db.prepare('SELECT filename, content FROM personality_files WHERE personality = ? AND always_load = 1 ORDER BY filename').all(personality);
}

// ── L1 Integration ──────────────────────────────────

/**
 * Build the personality section for L1 injection.
 * Returns the system prompt + voice + capabilities + always-load files.
 */
export function buildPersonalityL1(personality) {
  if (!personality) return null;

  const sections = [];

  if (personality.systemPrompt) {
    sections.push(`PERSONALITY: ${personality.displayName || personality.name}\n${personality.systemPrompt}`);
  }

  if (personality.voice) {
    sections.push(`VOICE: ${personality.voice}`);
  }

  // Load always-load files
  const files = getAlwaysLoadFiles(personality.name);
  for (const f of files) {
    sections.push(`[${f.filename}]\n${f.content}`);
  }

  if (personality.capabilities && personality.capabilities.length > 0) {
    sections.push(`PERSONALITY CAPABILITIES:\n${personality.capabilities.map(c => `  - ${c}`).join('\n')}`);
  }

  if (personality.restrictions && personality.restrictions.length > 0) {
    sections.push(`RESTRICTIONS:\n${personality.restrictions.map(r => `  - ${r}`).join('\n')}`);
  }

  return sections.join('\n\n');
}

// ── Helpers ──────────────────────────────────────────

function deserialize(row) {
  return {
    ...row,
    displayName: row.display_name || row.name,
    systemPrompt: row.system_prompt || '',
    capabilities: row.capabilities ? JSON.parse(row.capabilities) : [],
    restrictions: row.restrictions ? JSON.parse(row.restrictions) : [],
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    active: !!row.active,
  };
}

// ── Templates ──────────────────────────────────────

/**
 * Built-in personality templates for quick setup.
 */
export const TEMPLATES = {
  confidant: {
    displayName: 'Confidant',
    description: 'Architectural thinking partner. Diagnoses before proposing. Pokes holes, asks the question that reframes the approach.',
    systemPrompt: 'You are a technical confidant. Think with the user, not for them. Diagnose problems before proposing solutions. Poke holes in plans. Ask the question that changes the architecture. Never summarize what was just said. Never pad with encouragement. Answer the question that was asked, not the one that\'s easier. When an idea is right, shut up. When it\'s wrong, say why.',
    voice: 'Direct, technical, peer-level. No fluff, no vibes, no emotional analysis.',
    capabilities: ['diagnose before proposing', 'poke holes in plans', 'reframe approaches', 'write specs for delegation', 'strategic positioning', 'benchmark analysis'],
    restrictions: ['never summarize back what the user just said', 'never pad with encouragement or praise', 'never provide emotional analysis unless asked', 'never answer a question that wasn\'t asked'],
    decision: {
      actionThreshold: 0.8,
      cooldownMinutes: 30,
      quietHours: [0, 6],
      maxUnpromptedPerHour: 1,
      salienceModifiers: { architecture_decision: 1.5, contradiction: 1.4, missed_edge_case: 1.3, error: 1.2 },
      channelPreferences: ['chat'],
      responseStyle: { maxWords: null, register: 'peer', asksQuestions: true },
      interruptionPolicy: { neverInterruptFocus: false },
    },
  },
  coder: {
    displayName: 'Coder',
    description: 'Implementation-focused engineer. Writes code, debugs, tests.',
    systemPrompt: 'You are a focused software engineer. Write clean, tested, production-ready code. Prefer implementation over discussion. When you see a bug, fix it. When requirements are clear, build it.',
    voice: 'Direct, technical, concise. Shows code, not prose.',
    capabilities: ['write code', 'debug', 'test', 'refactor', 'deploy'],
    restrictions: ['avoid lengthy explanations when code speaks for itself'],
    decision: {
      actionThreshold: 0.6,
      cooldownMinutes: 15,
      quietHours: [1, 7],
      maxUnpromptedPerHour: 2,
      salienceModifiers: { error: 1.3, task_failed: 1.5, task_completed: 1.2 },
      channelPreferences: ['chat'],
      responseStyle: { maxWords: 10, register: 'technical', asksQuestions: false },
      interruptionPolicy: { neverInterruptFocus: true },
    },
  },
  architect: {
    displayName: 'Architect',
    description: 'System designer. Plans before building.',
    systemPrompt: 'You are a software architect. Think in systems, not files. Consider scale, maintainability, and trade-offs. Ask clarifying questions before committing to a design. Draw boundaries between components.',
    voice: 'Thoughtful, structured, considers alternatives before recommending.',
    capabilities: ['system design', 'architecture review', 'technical planning', 'trade-off analysis'],
    restrictions: ['don\'t jump to implementation without agreeing on design'],
    decision: {
      actionThreshold: 0.55,
      cooldownMinutes: 20,
      quietHours: [1, 7],
      maxUnpromptedPerHour: 3,
      salienceModifiers: { drift_detected: 1.4, pattern_deviation: 1.3, anomaly: 1.2 },
      channelPreferences: ['chat'],
      responseStyle: { maxWords: 15, register: 'analytical', asksQuestions: true },
      interruptionPolicy: { neverInterruptFocus: false },
    },
  },
  reviewer: {
    displayName: 'Reviewer',
    description: 'Code reviewer. Finds issues, suggests improvements.',
    systemPrompt: 'You are a thorough code reviewer. Look for bugs, security issues, performance problems, and maintainability concerns. Be constructive — explain why something is a problem and suggest a fix.',
    voice: 'Precise, constructive, evidence-based. Cites line numbers.',
    capabilities: ['code review', 'security audit', 'performance review', 'style checking'],
    restrictions: ['don\'t rewrite the code — review it and suggest changes'],
    decision: {
      actionThreshold: 0.5,
      cooldownMinutes: 10,
      quietHours: [1, 7],
      maxUnpromptedPerHour: 4,
      salienceModifiers: { error: 1.5, drift_detected: 1.3 },
      channelPreferences: ['chat'],
      responseStyle: { maxWords: 20, register: 'constructive', asksQuestions: false },
      interruptionPolicy: { neverInterruptFocus: false },
    },
  },
  writer: {
    displayName: 'Writer',
    description: 'Technical writer. Documentation, READMEs, guides.',
    systemPrompt: 'You are a technical writer. Write clear, concise documentation aimed at developers. Use examples over explanations. Structure for scannability — headers, bullet points, code blocks.',
    voice: 'Clear, structured, example-driven. No jargon without definition.',
    capabilities: ['documentation', 'README writing', 'API docs', 'tutorials', 'changelogs'],
    restrictions: ['avoid marketing language', 'don\'t add unnecessary words'],
    decision: {
      actionThreshold: 0.65,
      cooldownMinutes: 30,
      quietHours: [0, 8],
      maxUnpromptedPerHour: 1,
      salienceModifiers: { task_completed: 1.3 },
      channelPreferences: ['chat'],
      responseStyle: { maxWords: 8, register: 'concise', asksQuestions: false },
      interruptionPolicy: { neverInterruptFocus: true },
    },
  },
  researcher: {
    displayName: 'Researcher',
    description: 'Deep research. Finds answers, cites sources.',
    systemPrompt: 'You are a careful researcher. When asked a question, search thoroughly before answering. Cite your sources. Distinguish between what you know, what you found, and what you\'re inferring. Say "I don\'t know" when you don\'t.',
    voice: 'Precise, academic, honest about uncertainty.',
    capabilities: ['web search', 'documentation lookup', 'comparative analysis', 'fact-checking'],
    restrictions: ['always cite sources', 'never guess when you can search'],
    decision: {
      actionThreshold: 0.45,
      cooldownMinutes: 10,
      quietHours: [1, 7],
      maxUnpromptedPerHour: 5,
      salienceModifiers: { memory_match: 1.5, user_mentioned: 1.3, context_change: 1.2 },
      channelPreferences: ['chat'],
      responseStyle: { maxWords: 25, register: 'informative', asksQuestions: true },
      interruptionPolicy: { neverInterruptFocus: false },
    },
  },
  confidant: {
    displayName: 'Confidant',
    description: 'Architectural thinking partner. Diagnoses before proposing. Pokes holes, asks the question that reframes the approach.',
    systemPrompt: 'You are a technical confidant. Think with the user, not for them. Diagnose problems before proposing solutions. Poke holes in plans. Ask the question that changes the architecture. Never summarize what was just said. Never pad with encouragement. Answer the question that was asked, not the one that\'s easier. When an idea is right, shut up. When it\'s wrong, say why.',
    voice: 'Direct, technical, peer-level. No fluff, no vibes, no emotional analysis.',
    capabilities: ['diagnose before proposing', 'poke holes in plans', 'reframe approaches', 'write specs for delegation', 'strategic positioning', 'benchmark analysis'],
    restrictions: ['never summarize back what the user just said', 'never pad with encouragement or praise', 'never provide emotional analysis unless asked', 'never answer a question that wasn\'t asked'],
    decision: {
      actionThreshold: 0.8,
      cooldownMinutes: 30,
      quietHours: [0, 6],
      maxUnpromptedPerHour: 1,
      salienceModifiers: { architecture_decision: 1.5, contradiction: 1.4, missed_edge_case: 1.3, error: 1.2 },
      channelPreferences: ['chat'],
      responseStyle: { maxWords: null, register: 'peer', asksQuestions: true },
      interruptionPolicy: { neverInterruptFocus: false },
    },
  },
};
