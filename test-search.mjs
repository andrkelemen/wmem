import { search } from './core/db.mjs';

const r = search('bluetooth speaker', { limit: 3 });
console.log('search results:', r.length);
r.forEach(row => console.log(`  [${row.source_type}] ${row.content.slice(0, 100)}`));
