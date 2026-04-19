/**
 * facts.mjs — Index-time fact extraction via pattern matching
 *
 * No LLM. Regex-based extraction of user self-statements.
 * "I graduated with a Business Administration degree" →
 *   { predicate: "graduated_with", object: "Business Administration degree" }
 *
 * Facts are stored as additional searchable chunks with source_type 'fact'.
 * This bridges the keyword gap: searching for "degree" now finds the
 * extracted fact even if the original phrasing was different.
 */

// Patterns that capture user self-statements
// [subject implicitly "user"] [predicate] [object]
const FACT_PATTERNS = [
  // Identity / bio
  { regex: /\bmy name is ([A-Z][a-z]+(?: [A-Z][a-z]+)*)/gi, predicate: 'name_is' },
  { regex: /\bI(?:'m| am) (\d+)(?: years old)?/gi, predicate: 'age_is' },
  { regex: /\bI(?:'m| am) from ([A-Z][a-z]+(?: [A-Z][a-z]+)*)/gi, predicate: 'from' },
  { regex: /\bI live in ([A-Z][a-z]+(?: [A-Za-z]+)*)/gi, predicate: 'lives_in' },
  { regex: /\bI(?:'m| am) a ([a-z]+(?: [a-z]+){0,3})/gi, predicate: 'occupation' },
  { regex: /\bI work (?:at|for) ([A-Z][A-Za-z]+(?: [A-Za-z]+)*)/gi, predicate: 'works_at' },

  // Education
  { regex: /\bI graduated (?:with|from) (?:a )?(?:degree in )?([A-Z][A-Za-z]+(?: [A-Za-z]+){0,4})/gi, predicate: 'graduated_with' },
  { regex: /\bI(?:'ve| have) (?:a |an )?([A-Z][a-z]+'s|Bachelor'?s?|Master'?s?|PhD|MBA|degree) (?:in |of )?([A-Za-z]+(?: [A-Za-z]+){0,3})/gi, predicate: 'has_degree' },
  { regex: /\bI (?:study|studied|majored in) ([A-Za-z]+(?: [A-Za-z]+){0,3})/gi, predicate: 'studied' },

  // Preferences
  { regex: /\bmy favorite ([a-z]+(?: [a-z]+)?) is ([A-Za-z]+(?: [A-Za-z]+){0,4})/gi, predicate: 'favorite' },
  { regex: /\bI (?:really )?(?:love|enjoy|prefer) ([a-z]+(?: [a-z]+){0,4})/gi, predicate: 'enjoys' },
  { regex: /\bI(?:'m| am) (?:allergic to|intolerant to) ([a-z]+(?: [a-z]+){0,3})/gi, predicate: 'allergic_to' },
  { regex: /\bI (?:don'?t|hate|can'?t stand) ([a-z]+(?: [a-z]+){0,4})/gi, predicate: 'dislikes' },

  // Relationships
  { regex: /\bmy (?:wife|husband|spouse|partner)(?:'s name is| is) ([A-Z][a-z]+(?: [A-Z][a-z]+)*)/gi, predicate: 'partner_name' },
  { regex: /\bmy (?:dog|cat|pet)(?:'s name is| is called) ([A-Z][a-z]+)/gi, predicate: 'pet_name' },
  { regex: /\bI have (\d+) (?:brothers?|sisters?|siblings?|kids?|children)/gi, predicate: 'has_count' },
  { regex: /\bmy (?:brother|sister)(?:'s name is| is) ([A-Z][a-z]+)/gi, predicate: 'sibling_name' },

  // Life events
  { regex: /\bI (?:just )?(?:moved|relocated) to ([A-Z][a-z]+(?: [A-Za-z]+)*)/gi, predicate: 'moved_to' },
  { regex: /\bI (?:just )?(?:got|started|began) (?:a )?(?:new )?(?:job|position|role) (?:at|as) ([A-Za-z]+(?: [A-Za-z]+){0,4})/gi, predicate: 'new_job' },
  { regex: /\bI (?:just )?(?:bought|purchased|got) (?:a |an )?([a-z]+(?: [a-z]+){0,4})/gi, predicate: 'bought' },
  { regex: /\bI(?:'m| am) (?:planning|going) to ([a-z]+(?: [a-z]+){0,4})/gi, predicate: 'planning_to' },

  // Temporal
  { regex: /\bI was born (?:on |in )?([A-Z][a-z]+ \d{1,2}(?:,? \d{4})?|\d{4})/gi, predicate: 'born_on' },
  { regex: /\bmy birthday is ([A-Z][a-z]+ \d{1,2})/gi, predicate: 'birthday' },
];

/**
 * Extract facts from a text chunk.
 * Returns an array of { predicate, object, source } for each match.
 */
export function extractFacts(content) {
  if (!content || content.length < 20) return [];

  // Only extract from user messages (they contain self-statements)
  if (!content.startsWith('[user]')) return [];

  const text = content.replace(/^\[user\]\s*/, '');
  const facts = [];

  for (const { regex, predicate } of FACT_PATTERNS) {
    // Reset regex state
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const object = (match[2] || match[1] || '').trim();
      if (object && object.length > 1 && object.length < 100) {
        facts.push({ predicate, object });
      }
    }
  }

  return facts;
}

/**
 * Convert extracted facts into searchable fact chunks.
 * These get indexed alongside the original content for better recall.
 */
export function factsToChunks(facts, originalChunk) {
  return facts.map(f => ({
    content: `[fact] ${f.predicate}: ${f.object}`,
    sourceType: 'fact',
    sessionId: originalChunk.sessionId,
    timestamp: originalChunk.timestamp,
    metadata: JSON.stringify({ predicate: f.predicate, object: f.object, source_chunk: originalChunk.id }),
  }));
}

export { FACT_PATTERNS };
