import test from 'node:test';
import assert from 'node:assert/strict';
import { assignArtifact, clearSlot, createSlotAssignments, moveSlot, normalizeTargetCount, validateSlotAssignments } from '../src/shared/slot-assignments.js';

test('normalizes target counts to 4, 6 or 8', () => {
  assert.equal(normalizeTargetCount(6), 6);
  assert.equal(normalizeTargetCount(7, 8), 8);
  assert.equal(normalizeTargetCount('invalid'), 4);
});

test('assigns, replaces and swaps artifacts without duplicates', () => {
  const allowed = ['a', 'b', 'c', 'd'];
  let assignments = createSlotAssignments([], 4);
  assignments = assignArtifact(assignments, 'a', 0, allowed);
  assignments = assignArtifact(assignments, 'b', 1, allowed);
  assignments = assignArtifact(assignments, 'a', 1, allowed);
  assert.deepEqual(assignments, ['b', 'a', null, null]);
  assignments = moveSlot(assignments, 0, 2);
  assert.deepEqual(assignments, [null, 'a', 'b', null]);
  assignments = clearSlot(assignments, 1);
  assert.deepEqual(assignments, [null, null, 'b', null]);
});

test('requires complete unique slot assignments', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.equal(validateSlotAssignments(ids, ids, 4), true);
  assert.equal(validateSlotAssignments(['a', 'a', 'c', 'd'], ids, 4), false);
  assert.equal(validateSlotAssignments(['a', 'b', null, 'd'], ids, 4), false);
});
