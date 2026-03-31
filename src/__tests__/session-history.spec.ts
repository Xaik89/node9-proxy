// src/__tests__/session-history.spec.ts
// Unit tests for session history tracking (stateful smart rules).

import { describe, it, expect, beforeEach } from 'vitest';
import { sessionHistory } from '../daemon/session-history.js';

describe('sessionHistory', () => {
  beforeEach(() => {
    sessionHistory.reset();
  });

  describe('initial state', () => {
    it('checkPredicate returns false when no edits have occurred', () => {
      expect(sessionHistory.checkPredicate('no_test_passed_since_last_edit')).toBe(false);
    });

    it('returns false for unknown predicate', () => {
      expect(sessionHistory.checkPredicate('unknown_predicate')).toBe(false);
    });
  });

  describe('no_test_passed_since_last_edit', () => {
    it('returns true after edit with no test run', () => {
      sessionHistory.recordEdit(1000);
      expect(sessionHistory.checkPredicate('no_test_passed_since_last_edit')).toBe(true);
    });

    it('returns true after edit followed by failing test', () => {
      sessionHistory.recordEdit(1000);
      sessionHistory.recordTestFail(2000);
      expect(sessionHistory.checkPredicate('no_test_passed_since_last_edit')).toBe(true);
    });

    it('returns false after edit followed by passing test', () => {
      sessionHistory.recordEdit(1000);
      sessionHistory.recordTestPass(2000);
      expect(sessionHistory.checkPredicate('no_test_passed_since_last_edit')).toBe(false);
    });

    it('returns true when edit happens after passing test', () => {
      sessionHistory.recordTestPass(1000);
      sessionHistory.recordEdit(2000);
      expect(sessionHistory.checkPredicate('no_test_passed_since_last_edit')).toBe(true);
    });

    it('returns false when passing test and edit have same timestamp', () => {
      // Test at same time as edit — "not before" means it counts
      sessionHistory.recordEdit(1000);
      sessionHistory.recordTestPass(1000);
      // lastTestPassAt (1000) is NOT < lastEditAt (1000) → returns false
      expect(sessionHistory.checkPredicate('no_test_passed_since_last_edit')).toBe(false);
    });

    it('cycle: edit → pass → edit → returns true again', () => {
      sessionHistory.recordEdit(1000);
      sessionHistory.recordTestPass(2000);
      expect(sessionHistory.checkPredicate('no_test_passed_since_last_edit')).toBe(false);

      sessionHistory.recordEdit(3000);
      expect(sessionHistory.checkPredicate('no_test_passed_since_last_edit')).toBe(true);
    });

    it('pass clears the block even after multiple edits and fails', () => {
      sessionHistory.recordEdit(1000);
      sessionHistory.recordTestFail(1500);
      sessionHistory.recordEdit(2000);
      sessionHistory.recordTestFail(2500);
      sessionHistory.recordTestPass(3000);
      expect(sessionHistory.checkPredicate('no_test_passed_since_last_edit')).toBe(false);
    });
  });

  describe('getSnapshot', () => {
    it('returns null timestamps before any events', () => {
      const snap = sessionHistory.getSnapshot();
      expect(snap.lastEditAt).toBeNull();
      expect(snap.lastTestPassAt).toBeNull();
      expect(snap.lastTestFailAt).toBeNull();
    });

    it('reflects recorded timestamps', () => {
      sessionHistory.recordEdit(1000);
      sessionHistory.recordTestPass(2000);
      sessionHistory.recordTestFail(3000);
      const snap = sessionHistory.getSnapshot();
      expect(snap.lastEditAt).toBe(1000);
      expect(snap.lastTestPassAt).toBe(2000);
      expect(snap.lastTestFailAt).toBe(3000);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      sessionHistory.recordEdit(1000);
      sessionHistory.recordTestPass(2000);
      sessionHistory.recordTestFail(3000);
      sessionHistory.reset();
      const snap = sessionHistory.getSnapshot();
      expect(snap.lastEditAt).toBeNull();
      expect(snap.lastTestPassAt).toBeNull();
      expect(snap.lastTestFailAt).toBeNull();
      expect(sessionHistory.checkPredicate('no_test_passed_since_last_edit')).toBe(false);
    });
  });
});
