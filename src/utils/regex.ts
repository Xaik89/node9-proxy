// src/utils/regex.ts
// ReDoS-safe regex validation and LRU-cached compilation.
// Pure utility — no dependencies on config, audit, or policy modules.
import safeRegex from 'safe-regex2';

const MAX_REGEX_LENGTH = 100;
const REGEX_CACHE_MAX = 500;
const regexCache = new Map<string, RegExp>();

/**
 * Validates a user-supplied regex pattern against known ReDoS vectors.
 * Returns null if valid, or an error string describing the problem.
 */
export function validateRegex(pattern: string): string | null {
  if (!pattern) return 'Pattern is required';
  if (pattern.length > MAX_REGEX_LENGTH) return `Pattern exceeds max length of ${MAX_REGEX_LENGTH}`;

  // Compile check first — rejects structurally invalid patterns (unbalanced parens,
  // bad escapes, etc.) before they reach safe-regex2, which may misanalyse them.
  try {
    new RegExp(pattern);
  } catch (e) {
    return `Invalid regex syntax: ${(e as Error).message}`;
  }

  // Quantified backreferences — safe-regex2 does not analyse backreferences,
  // so we keep this explicit guard: \1+ \2* \1{2,} can cause catastrophic backtracking.
  // \d+ matches multi-digit group numbers (\10, \11, …) correctly.
  if (/\\\d+[*+{]/.test(pattern)) return 'Quantified backreferences are forbidden (ReDoS risk)';

  // ReDoS check via safe-regex2 — proper NFA analysis, replaces the previous
  // hand-rolled heuristics which had false positives ((GET|POST)+) and false
  // negatives ((x|xx)*). safe-regex2 correctly handles both cases.
  if (!safeRegex(pattern)) return 'Pattern rejected: potential ReDoS vulnerability detected';

  return null;
}

/**
 * Compiles a regex with validation and LRU caching.
 * Returns null if the pattern is invalid or dangerous.
 */
export function getCompiledRegex(pattern: string, flags = ''): RegExp | null {
  // Validate flags before anything else — invalid flags (e.g. 'z') would throw
  // inside new RegExp() and could leak debug info; reject them explicitly.
  if (flags && !/^[gimsuy]+$/.test(flags)) {
    if (process.env.NODE9_DEBUG === '1') console.error(`[Node9] Invalid regex flags: "${flags}"`);
    return null;
  }
  const key = `${pattern}\0${flags}`;
  if (regexCache.has(key)) {
    // LRU bump: move to insertion-order end
    const cached = regexCache.get(key)!;
    regexCache.delete(key);
    regexCache.set(key, cached);
    return cached;
  }

  const err = validateRegex(pattern);
  if (err) {
    if (process.env.NODE9_DEBUG === '1')
      console.error(`[Node9] Regex blocked: ${err} — pattern: "${pattern}"`);
    return null;
  }

  try {
    const re = new RegExp(pattern, flags);
    if (regexCache.size >= REGEX_CACHE_MAX) {
      const oldest = regexCache.keys().next().value;
      if (oldest) regexCache.delete(oldest);
    }
    regexCache.set(key, re);
    return re;
  } catch (e) {
    if (process.env.NODE9_DEBUG === '1') console.error(`[Node9] Regex compile failed:`, e);
    return null;
  }
}
