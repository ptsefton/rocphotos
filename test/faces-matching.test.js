import { describe, it, expect } from 'vitest';
import { euclideanDistance, findClosestReference, MATCH_THRESHOLD, MATCH_MARGIN } from '../src/core/faces/matching.js';

describe('euclideanDistance', () => {
  it('is zero for identical vectors', () => {
    expect(euclideanDistance([1, 2, 3], [1, 2, 3])).toEqual(0);
  });

  it('computes the straight-line distance between two vectors', () => {
    expect(euclideanDistance([0, 0], [3, 4])).toEqual(5);
  });
});

describe('findClosestReference', () => {
  const alice = { id: 'ref-1', personId: 'arcp://name,rocphoto/person/alice', personName: 'Alice', embedding: [0, 0] };
  const bob = { id: 'ref-2', personId: 'arcp://name,rocphoto/person/bob', personName: 'Bob', embedding: [10, 10] };

  it('returns null when no reference is within MATCH_THRESHOLD', () => {
    expect(findClosestReference([100, 100], [alice, bob])).toBeNull();
  });

  it('returns the closest reference within threshold, with its distance', () => {
    const result = findClosestReference([0.1, 0.1], [alice, bob]);
    expect(result.reference).toBe(alice);
    expect(result.distance).toBeLessThan(MATCH_THRESHOLD);
  });

  it('picks the nearer of two references both within threshold', () => {
    const close = { id: 'ref-3', personId: 'p', personName: 'Close', embedding: [0.1, 0.1] };
    const farther = { id: 'ref-4', personId: 'p2', personName: 'Farther', embedding: [0.3, 0.3] };
    const result = findClosestReference([0, 0], [farther, close]);
    expect(result.reference).toBe(close);
  });

  it('treats a stranger reference (personId null) the same as any other for closeness', () => {
    const stranger = { id: 'ref-5', personId: null, personName: null, embedding: [0, 0] };
    const result = findClosestReference([0.1, 0.1], [stranger]);
    expect(result.reference.personId).toBeNull();
  });

  it('returns null when the best match is not a clear winner over a different identity (MATCH_MARGIN)', () => {
    const alsoAlice = { id: 'ref-6', personId: 'arcp://name,rocphoto/person/alice', personName: 'Alice', embedding: [0, 0] };
    const carol = { id: 'ref-7', personId: 'arcp://name,rocphoto/person/carol', personName: 'Carol', embedding: [0, 0.01] };
    // alice and carol are both within a hair of the query — too close to
    // call, even though both are individually well within MATCH_THRESHOLD.
    expect(findClosestReference([0, 0], [alsoAlice, carol])).toBeNull();
  });

  it('does not treat two references for the *same* person as ambiguous with each other', () => {
    const aliceAgain = { id: 'ref-8', personId: 'arcp://name,rocphoto/person/alice', personName: 'Alice', embedding: [0, 0.01] };
    // Both references belong to Alice — however close together, this is
    // reinforcing evidence, not a competing identity, so it must not
    // block the match the way a different person this close would.
    const result = findClosestReference([0, 0], [aliceAgain, { id: 'ref-9', personId: 'arcp://name,rocphoto/person/alice', personName: 'Alice', embedding: [0, 0] }]);
    expect(result.reference.personName).toEqual('Alice');
    expect(result.distance).toEqual(0);
  });

  it('is not fooled by an ambiguous runner-up that is itself over MATCH_THRESHOLD', () => {
    // Regression guard for filtering withinThreshold before computing the
    // margin: a far-away "runner-up" must never suppress an otherwise
    // clean, unambiguous match.
    const alice = { id: 'ref-10', personId: 'arcp://name,rocphoto/person/alice', personName: 'Alice', embedding: [0, 0] };
    const distantStranger = { id: 'ref-11', personId: null, personName: null, embedding: [5, 5] };
    const result = findClosestReference([0, 0], [alice, distantStranger]);
    expect(result.reference.personName).toEqual('Alice');
  });

  it('MATCH_MARGIN is a real, positive number smaller than MATCH_THRESHOLD', () => {
    expect(MATCH_MARGIN).toBeGreaterThan(0);
    expect(MATCH_MARGIN).toBeLessThan(MATCH_THRESHOLD);
  });
});
