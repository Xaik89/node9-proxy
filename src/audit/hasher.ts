// src/audit/hasher.ts
// Privacy-safe audit hashing: replaces raw tool arguments with a deterministic
// SHA-256 digest so audit logs are correlation-capable but not secret-leaking.
//
// The hash is:
//   SHA-256( JSON.stringify(canonicalise(args)) )  →  hex string (first 32 chars)
//
// 32 hex chars = 128 bits. Collision probability is negligible for audit log
// volumes (birthday bound: ~2^64 entries for 50% collision chance).
//
// Canonicalisation sorts object keys so that {"b":1,"a":2} and {"a":2,"b":1}
// produce the same hash. Arrays are left in order (order matters for commands).
// Non-plain objects (Date, RegExp, Buffer) are converted to their string/JSON
// representation so they produce meaningful, stable hashes rather than {}.
import { createHash } from 'crypto';

/**
 * Recursively sort object keys for a stable JSON representation.
 * Arrays are left in insertion order; primitives are returned as-is.
 * Non-plain objects (Date, RegExp, Buffer, etc.) are coerced to a stable
 * string form so they hash meaningfully rather than collapsing to {}.
 *
 * Cycle detection: a WeakSet tracks visited objects. Circular references
 * are replaced with the sentinel string "[Circular]" instead of
 * stack-overflowing — important because tool args can come from untrusted
 * MCP servers that may send self-referencing payloads.
 */
export function canonicalise(value: unknown, _seen = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    if (_seen.has(value)) return '[Circular]';
    _seen.add(value);
    const result = value.map((v) => canonicalise(v, _seen));
    _seen.delete(value);
    return result;
  }
  // Non-plain objects: coerce to a stable primitive representation
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (_seen.has(value)) return '[Circular]';
  _seen.add(value);
  const obj = value as Record<string, unknown>;
  const result = Object.fromEntries(
    Object.keys(obj)
      .sort()
      .map((k) => [k, canonicalise(obj[k], _seen)])
  );
  _seen.delete(value);
  return result;
}

/**
 * Return a 32-char hex digest (128-bit prefix of SHA-256) of the tool arguments.
 * Identical args always produce the same digest — useful for deduplication
 * and correlation without exposing the original content.
 *
 * 128 bits: negligible collision probability for audit log volumes
 * (birthday bound ~2^64 entries for 50% collision chance).
 */
export function hashArgs(args: unknown): string {
  // null and undefined both canonicalise to null → same hash. This is
  // intentional: both represent "no args" and are indistinguishable for
  // audit correlation purposes.
  const canonical = JSON.stringify(canonicalise(args) ?? null);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}
