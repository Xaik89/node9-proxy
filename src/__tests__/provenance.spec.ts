import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { checkProvenance } from '../utils/provenance.js';

describe('checkProvenance', () => {
  let realpathSpy: ReturnType<typeof vi.spyOn>;
  let statSpy: ReturnType<typeof vi.spyOn>;
  let accessSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    realpathSpy = vi.spyOn(fs, 'realpathSync');
    statSpy = vi.spyOn(fs, 'statSync');
    accessSpy = vi.spyOn(fs, 'accessSync');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockBinary(resolvedPath: string, mode = 0o755) {
    // accessSync: succeed for the resolved path (found in PATH)
    accessSpy.mockImplementation((p: fs.PathLike) => {
      if (String(p).endsWith(path.basename(resolvedPath))) return undefined;
      throw new Error('ENOENT');
    });
    realpathSpy.mockReturnValue(resolvedPath);
    statSpy.mockReturnValue({ mode } as fs.Stats);
  }

  it('classifies /usr/bin/curl as system', () => {
    mockBinary('/usr/bin/curl');
    const result = checkProvenance('curl');
    expect(result.trustLevel).toBe('system');
    expect(result.resolvedPath).toBe('/usr/bin/curl');
  });

  it('classifies /usr/local/bin/node as managed', () => {
    mockBinary('/usr/local/bin/node');
    const result = checkProvenance('node');
    expect(result.trustLevel).toBe('managed');
  });

  it('classifies /tmp/curl as suspect', () => {
    mockBinary('/tmp/curl');
    const result = checkProvenance('curl');
    expect(result.trustLevel).toBe('suspect');
    expect(result.reason).toMatch(/temp directory/i);
  });

  it('classifies /var/tmp/evil as suspect', () => {
    mockBinary('/var/tmp/evil');
    const result = checkProvenance('evil');
    expect(result.trustLevel).toBe('suspect');
  });

  it('classifies a world-writable binary as suspect', () => {
    // mode 0o777 — bit 0o002 is set (world-writable)
    mockBinary('/usr/bin/curl', 0o777);
    const result = checkProvenance('curl');
    expect(result.trustLevel).toBe('suspect');
    expect(result.reason).toMatch(/world-writable/i);
  });

  it('classifies binary not found in PATH as unknown', () => {
    accessSpy.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const result = checkProvenance('notabinary');
    expect(result.trustLevel).toBe('unknown');
    expect(result.reason).toMatch(/not found/i);
  });

  it('classifies binary in project cwd as user', () => {
    const cwd = '/home/dev/myproject';
    mockBinary(`${cwd}/.bin/tool`);
    const result = checkProvenance('tool', cwd);
    expect(result.trustLevel).toBe('user');
    expect(result.reason).toMatch(/project directory/i);
  });

  it('classifies binary in unrecognized location as unknown', () => {
    mockBinary('/opt/custom/bin/mytool');
    const result = checkProvenance('mytool');
    expect(result.trustLevel).toBe('unknown');
    expect(result.reason).toMatch(/unrecognized/i);
  });

  it('handles absolute path input directly', () => {
    // When given an absolute path, skips PATH walk
    accessSpy.mockImplementation(() => undefined); // accept /tmp/tool
    realpathSpy.mockReturnValue('/tmp/tool');
    statSpy.mockReturnValue({ mode: 0o755 } as fs.Stats);
    const result = checkProvenance('/tmp/tool');
    expect(result.trustLevel).toBe('suspect');
  });
});
