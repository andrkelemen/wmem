/**
 * expander.mjs — Query expansion for better FTS5 recall
 *
 * No LLM. No embeddings. No API cost.
 * Two expansion strategies:
 *   1. Static synonyms — common word → related terms
 *   2. Graph-based — uses tag co-occurrence from the knowledge graph
 *
 * "degree graduate" → "degree OR graduate OR education OR university OR diploma"
 * Pure lookup. Instant. Deterministic.
 */

// ── Static Synonym Map ──────────────────────────────────
// Common terms and their semantically related words.
// Not exhaustive — covers the most common recall gaps.

const SYNONYMS = {
  // Education
  degree: ['education', 'university', 'college', 'diploma', 'bachelor', 'master', 'phd', 'graduated', 'major', 'studied'],
  graduate: ['graduated', 'degree', 'university', 'college', 'commencement', 'alumni'],
  school: ['university', 'college', 'education', 'class', 'campus', 'student'],
  study: ['studied', 'learning', 'course', 'class', 'research', 'major'],

  // Work
  job: ['work', 'career', 'position', 'role', 'employment', 'company', 'office'],
  work: ['job', 'career', 'office', 'company', 'employer', 'working'],
  salary: ['pay', 'income', 'compensation', 'wage', 'earn'],
  boss: ['manager', 'supervisor', 'lead', 'director'],
  hired: ['started', 'joined', 'employed', 'onboarded'],

  // People
  friend: ['friends', 'buddy', 'pal', 'companion'],
  family: ['parents', 'mother', 'father', 'brother', 'sister', 'sibling', 'relative'],
  partner: ['wife', 'husband', 'spouse', 'girlfriend', 'boyfriend'],
  dog: ['pet', 'puppy', 'animal', 'canine'],
  cat: ['pet', 'kitten', 'feline'],

  // Places
  home: ['house', 'apartment', 'residence', 'live', 'living'],
  city: ['town', 'place', 'location', 'area', 'neighborhood'],
  restaurant: ['eat', 'dinner', 'lunch', 'food', 'dining', 'cafe'],
  travel: ['trip', 'vacation', 'visit', 'went', 'flew', 'drove'],

  // Time
  birthday: ['born', 'birth', 'celebrate', 'age', 'year'],
  yesterday: ['last', 'recent', 'previous', 'before'],
  started: ['began', 'beginning', 'first', 'initial', 'joined'],
  stopped: ['quit', 'ended', 'finished', 'left'],

  // Activities
  bought: ['purchased', 'buy', 'got', 'ordered', 'acquired'],
  favorite: ['prefer', 'like', 'love', 'best', 'preferred', 'enjoy'],
  hobby: ['interest', 'passion', 'enjoy', 'activity', 'leisure'],
  cooking: ['cook', 'recipe', 'food', 'kitchen', 'meal'],
  exercise: ['workout', 'gym', 'fitness', 'run', 'sport'],
  read: ['book', 'reading', 'novel', 'author', 'literature'],
  music: ['song', 'listen', 'band', 'artist', 'album', 'concert'],

  // Tech
  code: ['programming', 'software', 'developer', 'coding', 'engineer'],
  deploy: ['deployment', 'ship', 'release', 'production', 'launch'],
  bug: ['error', 'issue', 'fix', 'debug', 'problem'],
  database: ['db', 'sql', 'sqlite', 'postgres', 'query'],

  // Preferences / opinions
  favorite: ['prefer', 'preferred', 'like', 'love', 'best', 'enjoy', 'choice', 'go-to'],
  prefer: ['favorite', 'like', 'enjoy', 'choose', 'preference', 'rather'],
  like: ['enjoy', 'love', 'prefer', 'fond', 'favorite', 'into'],
  hate: ['dislike', 'avoid', 'can\'t stand', 'don\'t like'],
  recommend: ['suggest', 'recommendation', 'advice', 'try'],

  // Health
  allergy: ['allergic', 'intolerant', 'sensitivity', 'reaction', 'avoid'],
  sick: ['ill', 'health', 'doctor', 'hospital', 'medical', 'condition'],
  exercise: ['workout', 'gym', 'fitness', 'run', 'sport', 'training', 'yoga'],
  diet: ['food', 'eating', 'nutrition', 'vegetarian', 'vegan', 'meal'],

  // Emotions / life events
  happy: ['excited', 'glad', 'thrilled', 'pleased', 'joy'],
  sad: ['upset', 'disappointed', 'unhappy', 'depressed', 'down'],
  married: ['wedding', 'spouse', 'wife', 'husband', 'marriage', 'engaged'],
  moved: ['relocate', 'moving', 'new place', 'apartment', 'house'],
  born: ['birthday', 'birth', 'age', 'born on', 'year old'],

  // Time expressions
  last: ['previous', 'recent', 'ago', 'before', 'earlier', 'past'],
  first: ['initial', 'earliest', 'originally', 'began', 'started'],
  recent: ['lately', 'recently', 'just', 'last week', 'last month'],
  plan: ['planning', 'going to', 'intend', 'want to', 'thinking about', 'considering'],
  remember: ['recall', 'mentioned', 'told', 'said', 'talked about'],

  // Common question patterns
  name: ['called', 'named', 'known as', 'goes by'],
  live: ['living', 'reside', 'stay', 'located', 'based', 'address', 'city', 'town'],
  cost: ['price', 'paid', 'spend', 'expensive', 'cheap', 'budget', 'money'],
  old: ['age', 'years old', 'born', 'birthday'],
  siblings: ['brother', 'sister', 'sibling', 'brothers', 'sisters'],
  children: ['kids', 'son', 'daughter', 'child', 'baby'],
  color: ['colour', 'red', 'blue', 'green', 'black', 'white', 'yellow', 'purple'],
  car: ['vehicle', 'drive', 'driving', 'automobile', 'truck'],
  phone: ['call', 'mobile', 'cellphone', 'number', 'contact'],
  movie: ['film', 'watch', 'cinema', 'theater', 'show', 'series'],
  book: ['read', 'reading', 'novel', 'author', 'literature', 'story'],
  game: ['play', 'playing', 'gaming', 'sport', 'team'],
  vacation: ['trip', 'travel', 'holiday', 'visit', 'getaway', 'beach', 'flight'],
  weather: ['temperature', 'rain', 'sunny', 'cold', 'hot', 'snow', 'forecast'],
  language: ['speak', 'speaking', 'fluent', 'native', 'bilingual', 'learned'],
  sleep: ['bed', 'sleeping', 'wake', 'nap', 'insomnia', 'tired', 'rest'],
  eat: ['food', 'meal', 'dinner', 'lunch', 'breakfast', 'restaurant', 'cooking'],
  drink: ['coffee', 'tea', 'water', 'beer', 'wine', 'alcohol', 'beverage'],
  meet: ['met', 'meeting', 'introduced', 'encounter', 'saw', 'ran into'],
  change: ['changed', 'switch', 'update', 'modify', 'different', 'new'],
  problem: ['issue', 'trouble', 'difficulty', 'challenge', 'concern', 'struggle'],
  help: ['assist', 'support', 'advice', 'guidance', 'suggestion'],
};

// ── Stop Words ──────────────────────────────────────────

const STOP_WORDS = new Set([
  'what', 'when', 'where', 'who', 'how', 'why', 'which',
  'did', 'does', 'do', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'can', 'could', 'would', 'should', 'will', 'may', 'might',
  'the', 'a', 'an', 'my', 'your', 'our', 'his', 'her', 'its', 'their',
  'i', 'me', 'we', 'you', 'he', 'she', 'it', 'they', 'them',
  'and', 'or', 'but', 'if', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'from', 'by', 'about', 'as', 'into', 'through', 'during', 'before', 'after',
  'that', 'this', 'than', 'not', 'no', 'so', 'just', 'also', 'very',
  'up', 'out', 'some', 'any', 'all', 'most', 'more', 'much', 'many',
  'tell', 'said', 'ever', 'much', 'recently', 'usually', 'often',
]);

/**
 * Expand a natural language query into an FTS5 OR query with synonyms.
 *
 * @param {string} query - Natural language question
 * @param {object} opts - { maxTerms, maxExpansions }
 * @returns {string} Expanded FTS5 query
 */
export function expandQuery(query, { maxTerms = 6, maxExpansions = 5 } = {}) {
  const words = query.replace(/[?!.,;:'"()]/g, '').split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  // Take top N terms
  const keyTerms = words.slice(0, maxTerms);
  const expanded = new Set(keyTerms);

  // Add synonyms
  for (const term of keyTerms) {
    const syns = SYNONYMS[term];
    if (syns) {
      for (const s of syns.slice(0, maxExpansions)) {
        expanded.add(s);
      }
    }
  }

  // Build FTS5 query: quote each term, join with OR
  const terms = [...expanded].map(t => `"${t.replace(/"/g, '')}"`);
  return terms.join(' OR ');
}

/**
 * Extract key terms from a query (no expansion, just cleanup).
 */
export function extractTerms(query) {
  return query.replace(/[?!.,;:'"()]/g, '').split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

export { SYNONYMS, STOP_WORDS };
