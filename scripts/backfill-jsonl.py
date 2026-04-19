#!/usr/bin/env python3
"""
backfill-jsonl.py — Index JSONL transcripts into wmem via HTTP API.

Ported from the original extract_dialogue() in chunk-session.py.
Python handles the huge JSONL lines that OOM node's readline.
Extracted messages are POSTed to wmem's /api/ingest in batches.

Usage:
    python scripts/backfill-jsonl.py --agent default
    python scripts/backfill-jsonl.py --agent default --dir ~/.claude/projects
    python scripts/backfill-jsonl.py --agent default --api http://localhost:4200
"""

import json
import sys
import os
import gc
import argparse
import hashlib
import urllib.request

CHUNK_SIZE = 2000  # chars per chunk, ~500 tokens
CHUNK_OVERLAP = 200
BATCH_SIZE = 50  # chunks per API call
MAX_CONTENT = 10000  # max chars to extract per message


def find_jsonl_files(base_dir, skip_subagents=True):
    files = []
    for root, dirs, filenames in os.walk(base_dir):
        if skip_subagents and 'subagents' in root:
            continue
        for f in filenames:
            if f.endswith('.jsonl'):
                files.append(os.path.join(root, f))
    return sorted(files)


def extract_messages(filepath):
    """Extract user/assistant message text from a JSONL file. Streams line by line."""
    messages = []
    with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            # Quick type check before full parse
            if '"type":"user"' not in line and '"type":"assistant"' not in line and \
               '"type": "user"' not in line and '"type": "assistant"' not in line:
                continue

            # For large lines, extract only the message field without full parse.
            # json.loads on a 1.4MB line creates huge intermediate objects python doesn't GC fast enough.
            if len(line) > 50000:
                # Extract message field via string search, not full JSON parse
                msg_idx = line.find('"message"')
                if msg_idx == -1:
                    continue
                brace = line.find('{', msg_idx)
                if brace == -1:
                    continue
                # Find matching close brace (message object is small)
                depth = 0
                end = -1
                for j in range(brace, min(brace + MAX_CONTENT + 2000, len(line))):
                    if line[j] == '{': depth += 1
                    elif line[j] == '}':
                        depth -= 1
                        if depth == 0:
                            end = j
                            break
                if end == -1:
                    continue
                try:
                    msg = json.loads(line[brace:end+1])
                except:
                    continue
                # Get type
                type_match = None
                for t_str in ('"type":"user"', '"type":"assistant"', '"type": "user"', '"type": "assistant"'):
                    if t_str in line[:200]:
                        type_match = 'user' if 'user' in t_str else 'assistant'
                        break
                if not type_match:
                    continue
                # Get timestamp/sessionId
                ts_start = line.find('"timestamp"')
                timestamp = 0
                if ts_start != -1:
                    colon = line.find(':', ts_start)
                    if colon != -1:
                        num = ''
                        for ch in line[colon+1:colon+20]:
                            if ch.isdigit(): num += ch
                            elif num: break
                        if num: timestamp = int(num)
                sid_start = line.find('"sessionId"')
                session_id = ''
                if sid_start != -1:
                    q1 = line.find('"', sid_start + 12)
                    if q1 != -1:
                        q2 = line.find('"', q1 + 1)
                        if q2 != -1:
                            session_id = line[q1+1:q2]
                d = {'type': type_match, 'message': msg, 'timestamp': timestamp, 'sessionId': session_id}
            else:
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue

            t = d.get('type')
            if t not in ('user', 'assistant'):
                continue

            msg = d.get('message', {})
            if not isinstance(msg, dict):
                continue

            role = msg.get('role', t)
            content = msg.get('content', '')
            text = ''

            if isinstance(content, str):
                text = content[:MAX_CONTENT].strip()
            elif isinstance(content, list):
                parts = []
                total_len = 0
                for item in content:
                    if isinstance(item, dict) and item.get('type') == 'text':
                        t_text = item.get('text', '')
                        remaining = MAX_CONTENT - total_len
                        if remaining <= 0:
                            break
                        parts.append(t_text[:remaining])
                        total_len += len(parts[-1])
                text = '\n'.join(parts).strip()

            if not text or len(text) < 10:
                continue
            if text == '[Request interrupted by user]':
                continue

            timestamp = d.get('timestamp', 0)
            session_id = d.get('sessionId', '')

            messages.append({
                'role': role,
                'text': text,
                'timestamp': timestamp,
                'session_id': session_id,
            })
            del d  # free the parsed object immediately

    return messages


def chunk_text(text):
    """Split text into chunks of ~CHUNK_SIZE with overlap."""
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


def post_batch(api_url, batch):
    """POST a batch of chunks to wmem /api/ingest."""
    data = json.dumps(batch).encode('utf-8')
    req = urllib.request.Request(
        f'{api_url}/api/ingest',
        data=data,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
            return result
    except Exception as e:
        print(f'  API error: {e}')
        return None


def load_manifest(path):
    try:
        with open(path) as f:
            return json.load(f)
    except:
        return {}


def save_manifest(path, m):
    with open(path, 'w') as f:
        json.dump(m, f, indent=2)


def main():
    parser = argparse.ArgumentParser(description='Backfill JSONL into wmem')
    parser.add_argument('--agent', default='default')
    parser.add_argument('--dir', default=os.path.expanduser('~/.claude/projects'))
    parser.add_argument('--api', default='http://localhost:4200')
    parser.add_argument('--include-subagents', action='store_true')
    parser.add_argument('--max-file-mb', type=float, default=10.0, help='Skip files larger than this (MB)')
    args = parser.parse_args()

    manifest_path = os.path.join(args.dir, '.wmem-indexed.json')
    manifest = load_manifest(manifest_path)

    files = find_jsonl_files(args.dir, skip_subagents=not args.include_subagents)
    print(f'wmem backfill — agent: {args.agent}, dir: {args.dir}')
    print(f'found {len(files)} JSONL files')

    total_inserted = 0
    total_deduped = 0
    total_messages = 0
    files_processed = 0

    for filepath in files:
        file_size_mb = os.path.getsize(filepath) / 1024 / 1024
        mtime = os.path.getmtime(filepath)
        key = filepath
        if key in manifest and manifest[key].get('mtime', 0) >= mtime:
            continue
        if file_size_mb > args.max_file_mb:
            print(f'  SKIP {os.path.basename(filepath)} ({file_size_mb:.1f} MB > {args.max_file_mb} MB limit)')
            continue

        print(f'  {os.path.basename(filepath)} ({file_size_mb:.1f} MB)...')
        messages = extract_messages(filepath)
        if not messages:
            manifest[key] = {'mtime': mtime, 'indexed': 0, 'chunks': 0}
            continue

        total_messages += len(messages)
        source_id = os.path.splitext(os.path.basename(filepath))[0]

        # Build chunks
        batch = []
        file_chunks = 0

        for msg in messages:
            prefixed = f'[{msg["role"]}] {msg["text"]}'
            chunks = chunk_text(prefixed)
            for i, chunk in enumerate(chunks):
                batch.append({
                    'agent': args.agent,
                    'sourceType': 'conversation',
                    'sourceId': source_id,
                    'sessionId': msg['session_id'],
                    'content': chunk,
                    'timestamp': msg['timestamp'],
                    'metadata': {'role': msg['role'], 'chunkIndex': i, 'totalChunks': len(chunks)},
                })
                file_chunks += 1

                if len(batch) >= BATCH_SIZE:
                    result = post_batch(args.api, batch)
                    if result:
                        total_inserted += result.get('inserted', 0)
                        total_deduped += result.get('deduped', 0)
                    batch = []

        # Flush remaining
        if batch:
            result = post_batch(args.api, batch)
            if result:
                total_inserted += result.get('inserted', 0)
                total_deduped += result.get('deduped', 0)

        manifest[key] = {'mtime': mtime, 'indexed': file_chunks, 'chunks': file_chunks}
        files_processed += 1
        print(f'    {len(messages)} messages → {file_chunks} chunks')
        del messages  # free before next file
        gc.collect()

    save_manifest(manifest_path, manifest)

    print(f'\nbackfill complete:')
    print(f'  files processed: {files_processed}/{len(files)}')
    print(f'  messages extracted: {total_messages}')
    print(f'  chunks inserted: {total_inserted}')
    print(f'  chunks deduped: {total_deduped}')
    print(f'  manifest: {manifest_path}')


if __name__ == '__main__':
    main()
