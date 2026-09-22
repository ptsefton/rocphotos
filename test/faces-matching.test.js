import { describe, it, expect } from 'vitest';
import { euclideanDistance, findClosestReference, MATCH_THRESHOLD } from '../src/core/faces/matching.js';

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
});
