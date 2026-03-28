// src/auth/trusted-hosts.ts
// Persistent trusted-host allowlist. Hosts added here downgrade pipe-chain
// exfiltration decisions: 'block' (critical) → 'review', 'review' (high) → 'allow'.
// Only the CLI can add entries — AI tool calls cannot modify this list.
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface TrustedHostEntry {
  host: string;
  addedAt: number;
  addedBy: 'user';
}

interface TrustedHostsFile {
  hosts: TrustedHostEntry[];
}

export function getTrustedHostsPath(): string {
  return path.join(os.homedir(), '.node9', 'trusted-hosts.json');
}

export function readTrustedHosts(): TrustedHostEntry[] {
  try {
    const raw = fs.readFileSync(getTrustedHostsPath(), 'utf8');
    const parsed = JSON.parse(raw) as TrustedHostsFile;
    return Array.isArray(parsed.hosts) ? parsed.hosts : [];
  } catch {
    return [];
  }
}

function writeTrustedHosts(hosts: TrustedHostEntry[]): void {
  const filePath = getTrustedHostsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.node9-tmp';
  fs.writeFileSync(tmp, JSON.stringify({ hosts }, null, 2));
  fs.renameSync(tmp, filePath);
}

/** Add a host to the trusted list. No-op if already present. */
export function addTrustedHost(host: string): void {
  const hosts = readTrustedHosts();
  if (hosts.some((h) => h.host === host)) return;
  hosts.push({ host, addedAt: Date.now(), addedBy: 'user' });
  writeTrustedHosts(hosts);
}

/** Remove a host from the trusted list. Returns true if removed, false if not found. */
export function removeTrustedHost(host: string): boolean {
  const hosts = readTrustedHosts();
  const filtered = hosts.filter((h) => h.host !== host);
  if (filtered.length === hosts.length) return false;
  writeTrustedHosts(filtered);
  return true;
}

/**
 * Normalizes a raw URL or hostname to a comparable FQDN.
 * Examples:
 *   "https://api.mycompany.com/collect" → "api.mycompany.com"
 *   "api.mycompany.com:443"             → "api.mycompany.com"
 *   "user@host.com"                     → "host.com"
 */
export function normalizeHost(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^https?:\/\//, '') // strip protocol
    .replace(/\/.*$/, '') // strip path
    .replace(/^[^@]+@/, '') // strip user@
    .replace(/:\d+$/, ''); // strip :port
}

/**
 * Returns true if `host` is trusted.
 * - Exact match: "api.mycompany.com" matches entry "api.mycompany.com"
 * - Wildcard: entry "*.mycompany.com" matches "api.mycompany.com" and "sub.api.mycompany.com"
 * - Protocol/path/port are stripped before comparison.
 * - "api.mycompany.com" does NOT match a bare "mycompany.com" entry.
 */
export function isTrustedHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return readTrustedHosts().some((entry) => {
    const entryHost = entry.host.toLowerCase();
    if (entryHost.startsWith('*.')) {
      const domain = entryHost.slice(2);
      return normalized === domain || normalized.endsWith('.' + domain);
    }
    return normalized === entryHost;
  });
}
