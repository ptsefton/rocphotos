import { describe, it, expect } from 'vitest';
import { euclideanDistance, findClosestReference, MATCH_THRESHOLD, MATCH_MARGIN, clusterUnmatched, CLUSTER_THRESHOLD } from '../src/core/faces/matching.js';

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

describe('clusterUnmatched', () => {
  it('groups mutually close detections into one cluster', () => {
    const a = { id: 'a', embedding: [0, 0] };
    const b = { id: 'b', embedding: [0.05, 0.05] };
    const c = { id: 'c', embedding: [0.06, 0.04] };
    const clusters = clusterUnmatched([a, b, c]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].map((d) => d.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('keeps distant detections in separate clusters', () => {
    const a = { id: 'a', embedding: [0, 0] };
    const b = { id: 'b', embedding: [10, 10] };
    const clusters = clusterUnmatched([a, b]);
    expect(clusters).toHaveLength(2);
  });

  it('does not chain two distant detections together through a coincidental middle one (complete-linkage)', () => {
    // b is close to both a and c, but a and c are themselves far apart —
    // single-linkage clustering would wrongly merge all three; this must
    // keep a and c separate from each other.
    const a = { id: 'a', embedding: [0, 0] };
    const b = { id: 'b', embedding: [0.3, 0] };
    const c = { id: 'c', embedding: [0.6, 0] };
    expect(euclideanDistance(a.embedding, b.embedding)).toBeLessThanOrEqual(CLUSTER_THRESHOLD);
    expect(euclideanDistance(b.embedding, c.embedding)).toBeLessThanOrEqual(CLUSTER_THRESHOLD);
    expect(euclideanDistance(a.embedding, c.embedding)).toBeGreaterThan(CLUSTER_THRESHOLD);

    const clusters = clusterUnmatched([a, b, c]);
    const idsPerCluster = clusters.map((cluster) => cluster.map((d) => d.id).sort());
    expect(idsPerCluster).not.toContainEqual(['a', 'b', 'c']);
    // a and c must never end up in the same cluster as each other.
    for (const ids of idsPerCluster) {
      if (ids.includes('a')) expect(ids).not.toContain('c');
    }
  });

  it('gives a face unlike anything else pending its own cluster of one', () => {
    const a = { id: 'a', embedding: [0, 0] };
    const lonely = { id: 'lonely', embedding: [50, 50] };
    const clusters = clusterUnmatched([a, lonely]);
    expect(clusters).toEqual(expect.arrayContaining([[a], [lonely]]));
  });

  it('returns nothing for an empty input', () => {
    expect(clusterUnmatched([])).toEqual([]);
  });
});
