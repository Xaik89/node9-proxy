// src/undo.ts
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const UNDO_LATEST_PATH = path.join(os.homedir(), '.node9', 'undo_latest.txt');

/**
 * Creates a "Shadow Snapshot" of the current repository state.
 * Uses a temporary Git index to ensure we don't interfere with the
 * user's own staged changes.
 */
export async function createShadowSnapshot(): Promise<string | null> {
  try {
    const cwd = process.cwd();
    if (!fs.existsSync(path.join(cwd, '.git'))) return null;

    // Use a unique temp index file so we don't touch the user's staging area
    const tempIndex = path.join(cwd, '.git', `node9_index_${Date.now()}`);
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };

    // 1. Stage all changes into the TEMP index
    spawnSync('git', ['add', '-A'], { env });

    // 2. Create a tree object from the TEMP index
    const treeRes = spawnSync('git', ['write-tree'], { env });
    const treeHash = treeRes.stdout.toString().trim();

    // Clean up the temp index file immediately
    if (fs.existsSync(tempIndex)) fs.unlinkSync(tempIndex);

    if (!treeHash || treeRes.status !== 0) return null;

    // 3. Create a dangling commit (not attached to any branch)
    const commitRes = spawnSync('git', [
      'commit-tree',
      treeHash,
      '-m',
      `Node9 AI Snapshot: ${new Date().toISOString()}`,
    ]);
    const commitHash = commitRes.stdout.toString().trim();

    if (commitHash && commitRes.status === 0) {
      const dir = path.dirname(UNDO_LATEST_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(UNDO_LATEST_PATH, commitHash);
      return commitHash;
    }
  } catch (err) {
    if (process.env.NODE9_DEBUG === '1') {
      console.error('[Node9 Undo Engine Error]:', err);
    }
  }
  return null;
}

/**
 * Reverts the current directory to a specific Git commit hash.
 */
export function applyUndo(hash: string): boolean {
  try {
    const res = spawnSync('git', ['restore', '--source', hash, '--staged', '--worktree', '.']);
    return res.status === 0;
  } catch {
    return false;
  }
}

export function getLatestSnapshotHash(): string | null {
  if (!fs.existsSync(UNDO_LATEST_PATH)) return null;
  return fs.readFileSync(UNDO_LATEST_PATH, 'utf-8').trim();
}
