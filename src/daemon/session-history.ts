// src/daemon/session-history.ts
// In-memory session history for stateful smart rules.
// Tracks file edits and test results so rules like "block git push
// if no passing test since last edit" can be enforced.
//
// State is daemon-lifetime: reset when the daemon restarts.
// If the daemon is not running, stateful rules are skipped (fail-open).

export type StatePredicate = 'no_test_passed_since_last_edit';

export const KNOWN_PREDICATES: StatePredicate[] = ['no_test_passed_since_last_edit'];

class SessionHistory {
  private lastEditAt: number | null = null;
  private lastTestPassAt: number | null = null;
  private lastTestFailAt: number | null = null;

  recordEdit(ts = Date.now()): void {
    this.lastEditAt = ts;
  }

  recordTestPass(ts = Date.now()): void {
    this.lastTestPassAt = ts;
  }

  recordTestFail(ts = Date.now()): void {
    this.lastTestFailAt = ts;
  }

  /**
   * Returns true when the named predicate is currently satisfied.
   * Unknown predicates always return false (fail-open: don't block on unknown state).
   */
  checkPredicate(name: string): boolean {
    switch (name) {
      case 'no_test_passed_since_last_edit':
        // True when: there has been at least one edit AND no passing test
        // has been recorded after that edit. If no edit has happened yet,
        // there is nothing to protect — return false (don't block).
        if (this.lastEditAt === null) return false;
        return this.lastTestPassAt === null || this.lastTestPassAt < this.lastEditAt;
      default:
        return false;
    }
  }

  getSnapshot(): {
    lastEditAt: number | null;
    lastTestPassAt: number | null;
    lastTestFailAt: number | null;
  } {
    return {
      lastEditAt: this.lastEditAt,
      lastTestPassAt: this.lastTestPassAt,
      lastTestFailAt: this.lastTestFailAt,
    };
  }

  reset(): void {
    this.lastEditAt = null;
    this.lastTestPassAt = null;
    this.lastTestFailAt = null;
  }
}

export const sessionHistory = new SessionHistory();
