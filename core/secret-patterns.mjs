/**
 * secret-patterns.mjs — Regex library for known-shape secrets
 *
 * Conservative by design — only patterns with distinctive prefixes or formats.
 * Generic shapes like "40-char base64" are excluded to keep false positives low.
 *
 * Used by:
 *   - memory_amend / memory_delete previews (redact before tool response hits API)
 *   - doctor --secrets scanner (surface matches for user review)
 */

export const SECRET_PATTERNS = [
  // OpenAI / Anthropic / other LLM provider keys
  { name: 'openai_key', regex: /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { name: 'anthropic_key', regex: /sk-ant-[A-Za-z0-9_-]{32,}/g },

  // GitHub tokens
  { name: 'github_pat', regex: /\bghp_[A-Za-z0-9]{36}\b/g },
  { name: 'github_oauth', regex: /\bgho_[A-Za-z0-9]{36}\b/g },
  { name: 'github_server', regex: /\bghs_[A-Za-z0-9]{36}\b/g },
  { name: 'github_user', regex: /\bghu_[A-Za-z0-9]{36}\b/g },

  // Cloud provider
  { name: 'aws_access_key', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'gcp_service_account', regex: /"type"\s*:\s*"service_account"/g },

  // Messaging / integrations
  { name: 'slack_token', regex: /\bxox[baprs]-[0-9a-zA-Z-]{10,}\b/g },
  { name: 'discord_bot_token', regex: /\b[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27}\b/g },

  // Payments
  { name: 'stripe_key', regex: /\bsk_(?:live|test)_[0-9a-zA-Z]{24,}\b/g },

  // Crypto / auth headers
  { name: 'private_key_pem', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'bearer_token', regex: /\bBearer\s+[A-Za-z0-9_.\-+/=]{20,}\b/gi },

  // Password-shape (broad — catches many false positives, but that's desired
  // in a scanner: user reviews matches). Lookbehind excludes in-word matches
  // like "bypassword" but still catches prefixed names like "db_password".
  { name: 'password_assignment', regex: /(?<![a-zA-Z])pass(?:wd|word)\s*[=:]\s*['"]?[^\s'"<>,;]{4,}/gi },
  { name: 'secret_assignment', regex: /(?<![a-zA-Z])(?:api[_-]?key|secret|token)\s*[=:]\s*['"]?[^\s'"<>,;]{12,}/gi },
];

/**
 * Scan text for secret matches. Returns non-overlapping matches with
 * offsets and pattern names. Does not mutate the input.
 *
 * @param {string} text
 * @returns {Array<{name, offset, length, preview}>}
 */
export function scanSecrets(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = [];
  for (const { name, regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      // Skip if already covered by a higher-priority earlier match at the
      // same offset (handles overlap between e.g. bearer_token and jwt).
      if (matches.some(x => x.offset <= m.index && x.offset + x.length >= m.index + m[0].length)) continue;
      matches.push({
        name,
        offset: m.index,
        length: m[0].length,
        preview: m[0].slice(0, 8) + (m[0].length > 8 ? '…' : ''),
      });
    }
  }
  return matches.sort((a, b) => a.offset - b.offset);
}

/**
 * Return text with all secret matches replaced by `[REDACTED:pattern_name]`.
 * Safe to pass through Claude API / tool responses.
 *
 * @param {string} text
 * @returns {{ text: string, matches: Array }}
 */
export function redactSecrets(text) {
  if (!text || typeof text !== 'string') return { text: text ?? '', matches: [] };
  const matches = scanSecrets(text);
  if (matches.length === 0) return { text, matches };

  // Redact from last to first so offsets don't shift as we splice.
  let out = text;
  for (const m of [...matches].reverse()) {
    out = out.slice(0, m.offset) + `[REDACTED:${m.name}]` + out.slice(m.offset + m.length);
  }
  return { text: out, matches };
}
