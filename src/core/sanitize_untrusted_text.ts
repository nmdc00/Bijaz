const DEFAULT_MAX_CHARS = 8000;

const SUSPICIOUS_PATTERNS = [
  /ignore (all|any|previous) instructions/i,
  /system prompt/i,
  /\byou are (chatgpt|claude|gpt|gpt-?5|assistant)\b/i,
  /\bact as\b/i,
  /\bdeveloper message\b/i,
  /begin system prompt/i,
  /end system prompt/i,
  /your name is/i,
  /you are now/i,
  /from now on/i,
  /new instructions/i,
  /forget (everything|your|all|previous)/i,
  /respond as/i,
  /roleplay as/i,
  /pretend (to be|you are)/i,
  /disregard (all|previous|your)/i,
  /\boverride\b/i,
  /\byou must now\b/i,
  /\bdo not identify as\b/i,
];

export function sanitizeUntrustedText(text: string, maxChars = DEFAULT_MAX_CHARS): string {
  if (!text) return text;

  const lines = text.split('\n');
  const sanitized: string[] = [];
  let inPromptLikeBlock = false;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('```')) {
      inPromptLikeBlock = !inPromptLikeBlock;
      continue;
    }

    if (inPromptLikeBlock) {
      if (SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(line))) {
        continue;
      }
    }

    if (SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(line))) {
      continue;
    }

    sanitized.push(line);
  }

  const result = sanitized.join('\n').trim();
  if (result.length <= maxChars) {
    return result;
  }

  return `${result.slice(0, maxChars)}\n\n[TRUNCATED]`;
}
