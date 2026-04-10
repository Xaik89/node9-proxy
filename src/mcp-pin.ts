// src/mcp-pin.ts
// MCP tool pinning — rug pull defense.
// Records SHA-256 hashes of MCP server tool definitions on first use.
// On subsequent connections, compares hashes and blocks if tools changed.
//
// Storage: ~/.node9/mcp-pins.json (atomic writes, mode 0o600)
// Pattern: follows shields.ts for file I/O conventions.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PinEntry {
  /** Human-readable label (the upstream command that was pinned) */
  label: string;
  /** SHA-256 hex hash of the canonicalized tool definitions */
  toolsHash: string;
  /** Tool names at the time of pinning (for display purposes) */
  toolNames: string[];
  /** Number of tools at the time of pinning */
  toolCount: number;
  /** ISO 8601 timestamp of when the pin was created */
  pinnedAt: string;
}

export interface PinsFile {
  servers: Record<string, PinEntry>;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getPinsFilePath(): string {
  return path.join(os.homedir(), '.node9', 'mcp-pins.json');
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hash of an array of MCP tool definitions.
 * Tools are sorted by name before hashing so order does not matter.
 */
export function hashToolDefinitions(tools: unknown[]): string {
  const sorted = [...tools].sort((a, b) => {
    const nameA = (a as { name?: string }).name ?? '';
    const nameB = (b as { name?: string }).name ?? '';
    return nameA.localeCompare(nameB);
  });
  const canonical = JSON.stringify(sorted);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Derive a short server key from the upstream command string.
 * Returns the first 16 hex chars of the SHA-256 hash.
 */
export function getServerKey(upstreamCommand: string): string {
  return crypto.createHash('sha256').update(upstreamCommand).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/** Read the pin registry from disk. Returns empty servers on missing/corrupt file. */
export function readMcpPins(): PinsFile {
  const filePath = getPinsFilePath();
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return { servers: {} };
    const parsed = JSON.parse(raw) as Partial<PinsFile>;
    if (!parsed.servers || typeof parsed.servers !== 'object' || Array.isArray(parsed.servers)) {
      return { servers: {} };
    }
    return { servers: parsed.servers };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`[node9] Warning: could not read MCP pins: ${String(err)}\n`);
    }
    return { servers: {} };
  }
}

/** Atomic write of the pin registry to disk. */
function writeMcpPins(data: PinsFile): void {
  const filePath = getPinsFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Pin operations
// ---------------------------------------------------------------------------

/**
 * Check whether a server's tool definitions match the pinned hash.
 * Returns:
 *   'new'      — no pin exists for this server (first connection)
 *   'match'    — hash matches the pinned value
 *   'mismatch' — hash differs from the pinned value (possible rug pull)
 */
export function checkPin(serverKey: string, currentHash: string): 'match' | 'mismatch' | 'new' {
  const pins = readMcpPins();
  const entry = pins.servers[serverKey];
  if (!entry) return 'new';
  return entry.toolsHash === currentHash ? 'match' : 'mismatch';
}

/** Save or overwrite a pin for a server. */
export function updatePin(
  serverKey: string,
  label: string,
  toolsHash: string,
  toolNames: string[]
): void {
  const pins = readMcpPins();
  pins.servers[serverKey] = {
    label,
    toolsHash,
    toolNames,
    toolCount: toolNames.length,
    pinnedAt: new Date().toISOString(),
  };
  writeMcpPins(pins);
}

/** Remove a single server's pin. */
export function removePin(serverKey: string): void {
  const pins = readMcpPins();
  delete pins.servers[serverKey];
  writeMcpPins(pins);
}

/** Clear all pins (fresh start). */
export function clearAllPins(): void {
  writeMcpPins({ servers: {} });
}
