/**
 * autotag.mjs — Auto-generate topic tags from chunk content
 *
 * Uses keyword extraction + embedding clustering to assign tags.
 * No model calls — tags are derived from content patterns.
 *
 * Tag categories:
 *   - topic: what the content is about (auth, deployment, debugging)
 *   - action: what happened (decision, fix, discussion, discovery)
 *   - project: auto-detected project references
 */

// Common topic patterns — expandable
const TOPIC_PATTERNS = [
  { pattern: /\b(auth|login|password|token|session|oauth|jwt|credential)\b/i, tag: 'auth' },
  { pattern: /\b(deploy|production|staging|ci\/cd|pipeline|release|ship)\b/i, tag: 'deployment' },
  { pattern: /\b(debug|error|bug|fix|crash|stack ?trace|exception)\b/i, tag: 'debugging' },
  { pattern: /\b(test|spec|assert|expect|mock|coverage|suite)\b/i, tag: 'testing' },
  { pattern: /\b(database|sql|sqlite|postgres|mongo|redis|migration|schema)\b/i, tag: 'database' },
  { pattern: /\b(api|endpoint|rest|graphql|grpc|http|request|response)\b/i, tag: 'api' },
  { pattern: /\b(docker|container|kubernetes|k8s|pod|service|compose)\b/i, tag: 'infrastructure' },
  { pattern: /\b(git|branch|merge|commit|pr|pull request|rebase)\b/i, tag: 'git' },
  { pattern: /\b(config|settings|env|environment|\.env|dotenv)\b/i, tag: 'config' },
  { pattern: /\b(performance|slow|latency|optimize|cache|memory|cpu)\b/i, tag: 'performance' },
  { pattern: /\b(security|vulnerability|xss|injection|cors|csrf)\b/i, tag: 'security' },
  { pattern: /\b(ui|frontend|css|style|component|layout|design)\b/i, tag: 'frontend' },
  { pattern: /\b(refactor|cleanup|restructure|rename|reorganize)\b/i, tag: 'refactor' },
  { pattern: /\b(install|setup|init|bootstrap|scaffold|onboard)\b/i, tag: 'setup' },
  { pattern: /\b(network|ssh|dns|ip|port|firewall|proxy|tls|ssl)\b/i, tag: 'networking' },
  { pattern: /\b(file|path|directory|read|write|fs|filesystem)\b/i, tag: 'filesystem' },
  { pattern: /\b(cron|schedule|timer|interval|background|queue|job)\b/i, tag: 'automation' },
  { pattern: /\b(log|monitor|metric|alert|dashboard|observab)\b/i, tag: 'observability' },

  // Personal / life patterns — for personal assistant and LongMemEval data
  { pattern: /\b(school|university|college|degree|graduate|diploma|major|semester|class|professor)\b/i, tag: 'education' },
  { pattern: /\b(family|parent|mother|father|mom|dad|brother|sister|sibling|son|daughter|wife|husband|spouse)\b/i, tag: 'family' },
  { pattern: /\b(friend|friends|social|party|gathering|meet ?up|hangout|invited)\b/i, tag: 'social' },
  { pattern: /\b(dog|cat|pet|puppy|kitten|vet|veterinar|walk the)\b/i, tag: 'pets' },
  { pattern: /\b(boyfriend|girlfriend|partner|dating|relationship|engaged|married|wedding|anniversary)\b/i, tag: 'relationship' },
  { pattern: /\b(favorite|prefer|love to|enjoy|hobby|hobbies|like to|passion)\b/i, tag: 'preference' },
  { pattern: /\b(health|exercise|workout|gym|running|yoga|diet|weight|sleep|meditation)\b/i, tag: 'fitness' },
  { pattern: /\b(doctor|hospital|medicine|prescription|surgery|symptom|diagnosis|sick|illness)\b/i, tag: 'medical' },
  { pattern: /\b(house|apartment|rent|mortgage|move|moving|landlord|roommate|neighborhood)\b/i, tag: 'housing' },
  { pattern: /\b(job|career|resume|interview|salary|promotion|hired|fired|retire)\b/i, tag: 'career' },
  { pattern: /\b(travel|trip|vacation|flight|hotel|airport|passport|visit|tour)\b/i, tag: 'travel' },
  { pattern: /\b(birthday|anniversary|graduated|promotion|milestone|achievement|celebration)\b/i, tag: 'milestone' },
  { pattern: /\b(cook|recipe|restaurant|food|meal|dinner|lunch|breakfast|eat|kitchen)\b/i, tag: 'food' },
  { pattern: /\b(movie|film|show|series|watch|book|read|music|song|album|concert|game|play)\b/i, tag: 'entertainment' },
  { pattern: /\b(money|budget|savings?|invest|bank|credit|debt|loan|pay|expense)\b/i, tag: 'finance' },
  { pattern: /\b(car|drive|bus|train|commute|traffic|uber|lyft|bike|bicycle)\b/i, tag: 'transport' },
  { pattern: /\b(phone|laptop|computer|tablet|device|app|software|update)\b/i, tag: 'devices' },
  { pattern: /\b(weather|rain|snow|temperature|sunny|cold|hot|forecast|storm)\b/i, tag: 'weather' },
  { pattern: /\b(language|speak|fluent|learn|practice|translate|french|spanish|chinese|japanese)\b/i, tag: 'language' },
  { pattern: /\b(plan|schedule|calendar|appointment|meeting|reminder|deadline|agenda)\b/i, tag: 'planning-personal' },
];

const ACTION_PATTERNS = [
  { pattern: /\b(decided|decision|chose|agreed|settled on|went with)\b/i, tag: 'decision' },
  { pattern: /\b(fixed|resolved|patched|solved|workaround)\b/i, tag: 'fix' },
  { pattern: /\b(discovered|found|realized|noticed|learned|TIL)\b/i, tag: 'discovery' },
  { pattern: /\b(blocked|stuck|waiting|depends on|can't proceed)\b/i, tag: 'blocker' },
  { pattern: /\b(shipped|deployed|released|published|launched|live)\b/i, tag: 'shipped' },
  { pattern: /\b(planned|roadmap|next step|todo|backlog|will do)\b/i, tag: 'planning' },
  { pattern: /\b(reviewed|review|feedback|approved|rejected|lgtm)\b/i, tag: 'review' },
];

/**
 * Generate tags for a chunk of text.
 *
 * @param {string} content - The chunk content to analyze
 * @returns {Array<{tag: string, confidence: number}>} Tags with confidence scores
 */
export function generateTags(content) {
  if (!content || content.length < 20) return [];

  const tags = new Map(); // tag → confidence

  // Topic patterns
  for (const { pattern, tag } of TOPIC_PATTERNS) {
    const matches = content.match(new RegExp(pattern, 'gi'));
    if (matches) {
      const confidence = Math.min(1.0, matches.length * 0.3);
      const existing = tags.get(tag) || 0;
      tags.set(tag, Math.max(existing, confidence));
    }
  }

  // Action patterns
  for (const { pattern, tag } of ACTION_PATTERNS) {
    const matches = content.match(new RegExp(pattern, 'gi'));
    if (matches) {
      const confidence = Math.min(1.0, matches.length * 0.4);
      const existing = tags.get(tag) || 0;
      tags.set(tag, Math.max(existing, confidence));
    }
  }

  return Array.from(tags.entries())
    .map(([tag, confidence]) => ({ tag, confidence }))
    .sort((a, b) => b.confidence - a.confidence);
}

export { TOPIC_PATTERNS, ACTION_PATTERNS };
