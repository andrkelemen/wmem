#!/usr/bin/env python3
"""
backfill-direct.py — Index JSONL transcripts directly into SQLite FTS5.
No HTTP API, no node server needed. Writes to the database file directly.

Usage:
    python scripts/backfill-direct.py --agent default
    python scripts/backfill-direct.py --agent default --db /tmp/wmem-test.db
"""

import json
import sys
import os
import gc
import sqlite3
import argparse
import hashlib

MAX_CONTENT = 10000
CHUNK_SIZE = 2000
CHUNK_OVERLAP = 200


def init_db(db_path):
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('''CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT,
        session_id TEXT,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        metadata TEXT,
        content_hash TEXT,
        created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    )''')
    conn.execute('''CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        content, content='chunks', content_rowid='id', tokenize='porter unicode61'
    )''')
    conn.execute('''CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
    END''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_chunks_agent ON chunks(agent)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash)')
    conn.commit()
    return conn


def simple_hash(s):
    return hashlib.md5(s.encode('utf-8', errors='replace')).hexdigest()[:12]


def chunk_text(text):
    if len(text) <= CHUNK_SIZE:
        return [text]
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        chunks.append(text[start:end])
        start = end - CHUNK_OVERLAP
        if start >= len(text):
            break
    return chunks


def extract_and_insert(filepath, agent, conn, existing_hashes):
    """Stream a JSONL file line by line, extract messages, insert into DB."""
    inserted = 0
    deduped = 0
    messages = 0

    with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            # Quick filter — don't even look at non-message lines
            if '"type":"user"' not in line and '"type":"assistant"' not in line and \
               '"type": "user"' not in line and '"type": "assistant"' not in line:
                continue

            # For large lines (>50KB), extract message without full JSON parse
            if len(line) > 50000:
                msg_data = extract_message_fast(line)
            else:
                msg_data = extract_message_full(line)

            if not msg_data:
                continue

            messages += 1
            role, text, timestamp, session_id = msg_data
            source_id = os.path.splitext(os.path.basename(filepath))[0]

            prefixed = f'[{role}] {text}'
            chunks = chunk_text(prefixed)

            for i, chunk in enumerate(chunks):
                h = simple_hash(chunk)
                if h in existing_hashes:
                    deduped += 1
                    continue
                existing_hashes.add(h)

                meta = json.dumps({'role': role, 'chunkIndex': i, 'totalChunks': len(chunks)})
                conn.execute(
                    'INSERT INTO chunks (agent, source_type, source_id, session_id, content, timestamp, metadata, content_hash) VALUES (?,?,?,?,?,?,?,?)',
                    (agent, 'conversation', source_id, session_id, chunk, timestamp, meta, h)
                )
                inserted += 1

            # Don't hold refs to large strings
            del line

    conn.commit()
    return messages, inserted, deduped


def extract_message_fast(line):
    """Extract message from a large JSONL line without full JSON parse."""
    # Find type
    type_val = None
    for needle in ('"type":"user"', '"type":"assistant"', '"type": "user"', '"type": "assistant"'):
        if needle in line[:300]:
            type_val = 'user' if 'user' in needle else 'assistant'
            break
    if not type_val:
        return None

    # Find message object
    msg_idx = line.find('"message"')
    if msg_idx == -1:
        return None
    brace = line.find('{', msg_idx)
    if brace == -1:
        return None

    # Find matching close brace
    depth = 0
    end = -1
    limit = min(brace + MAX_CONTENT + 2000, len(line))
    for j in range(brace, limit):
        if line[j] == '{':
            depth += 1
        elif line[j] == '}':
            depth -= 1
            if depth == 0:
                end = j
                break
    if end == -1:
        return None

    try:
        msg = json.loads(line[brace:end + 1])
    except:
        return None

    content = msg.get('content', '')
    text = ''
    if isinstance(content, str):
        text = content[:MAX_CONTENT].strip()
    elif isinstance(content, list):
        parts = []
        tl = 0
        for item in content:
            if isinstance(item, dict) and item.get('type') == 'text':
                t = item.get('text', '')
                r = MAX_CONTENT - tl
                if r <= 0:
                    break
                parts.append(t[:r])
                tl += len(parts[-1])
        text = '\n'.join(parts).strip()

    if not text or len(text) < 10 or text == '[Request interrupted by user]':
        return None

    role = msg.get('role', type_val)

    # Extract timestamp
    timestamp = 0
    ts_idx = line.find('"timestamp"')
    if ts_idx != -1 and ts_idx < 500:
        colon = line.find(':', ts_idx)
        if colon != -1:
            num = ''
            for ch in line[colon + 1:colon + 20]:
                if ch.isdigit():
                    num += ch
                elif num:
                    break
            if num:
                timestamp = int(num)

    # Extract sessionId
    session_id = ''
    sid_idx = line.find('"sessionId"')
    if sid_idx != -1:
        q1 = line.find('"', sid_idx + 12)
        if q1 != -1:
            q2 = line.find('"', q1 + 1)
            if q2 != -1 and q2 - q1 < 100:
                session_id = line[q1 + 1:q2]

    return (role, text, timestamp, session_id)


def extract_message_full(line):
    """Extract message from a small JSONL line via full JSON parse."""
    try:
        d = json.loads(line)
    except:
        return None

    t = d.get('type')
    if t not in ('user', 'assistant'):
        return None

    msg = d.get('message', {})
    if not isinstance(msg, dict):
        return None

    role = msg.get('role', t)
    content = msg.get('content', '')
    text = ''

    if isinstance(content, str):
        text = content[:MAX_CONTENT].strip()
    elif isinstance(content, list):
        parts = []
        tl = 0
        for item in content:
            if isinstance(item, dict) and item.get('type') == 'text':
                tt = item.get('text', '')
                r = MAX_CONTENT - tl
                if r <= 0:
                    break
                parts.append(tt[:r])
                tl += len(parts[-1])
        text = '\n'.join(parts).strip()

    if not text or len(text) < 10 or text == '[Request interrupted by user]':
        return None

    timestamp = d.get('timestamp', 0)
    session_id = d.get('sessionId', '')
    return (role, text, timestamp, session_id)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--agent', default='default')
    parser.add_argument('--dir', default=os.path.expanduser('~/.claude/projects'))
    parser.add_argument('--db', default='/tmp/wmem-test.db')
    parser.add_argument('--max-file-mb', type=float, default=100.0)
    args = parser.parse_args()

    print(f'wmem direct backfill — agent: {args.agent}, db: {args.db}')
    conn = init_db(args.db)

    # Load existing hashes for dedup
    existing = set(r[0] for r in conn.execute('SELECT content_hash FROM chunks').fetchall())
    print(f'existing chunks: {len(existing)}')

    # Find JSONL files
    files = []
    for root, dirs, filenames in os.walk(args.dir):
        if 'subagents' in root:
            continue
        for f in filenames:
            if f.endswith('.jsonl'):
                files.append(os.path.join(root, f))
    files.sort()
    print(f'found {len(files)} JSONL files')

    total_msg = 0
    total_ins = 0
    total_dup = 0
    processed = 0

    for filepath in files:
        size_mb = os.path.getsize(filepath) / 1024 / 1024
        if size_mb > args.max_file_mb:
            print(f'  SKIP {os.path.basename(filepath)} ({size_mb:.1f}MB)')
            continue

        msgs, ins, dup = extract_and_insert(filepath, args.agent, conn, existing)
        if msgs > 0:
            print(f'  {os.path.basename(filepath)}: {msgs} msgs → {ins} new, {dup} dup')
        total_msg += msgs
        total_ins += ins
        total_dup += dup
        processed += 1
        gc.collect()

    conn.close()
    print(f'\ndone: {processed} files, {total_msg} messages, {total_ins} inserted, {total_dup} deduped')


if __name__ == '__main__':
    main()
