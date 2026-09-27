import { describe, it, expect } from 'vitest';
import { buildOverviewTree } from '../webview/overviewUI.js';

describe('buildOverviewTree', () => {
  it('nests crates under the plain directories above them, e.g. year then month', () => {
    const tree = buildOverviewTree([
      { path: '2024/01', imageCount: 2, status: 'up-to-date' },
      { path: '2024/02', imageCount: 5, status: 'not-scanned' },
      { path: '2025/03', imageCount: 9, status: 'out-of-date' },
    ]);

    expect(tree.isCrate).toBe(false);
    expect(tree.children.map((c) => c.name)).toEqual(['2024', '2025']);

    const year2024 = tree.children.find((c) => c.name === '2024');
    expect(year2024.isCrate).toBe(false);
    expect(year2024.children.map((c) => c.name)).toEqual(['01', '02']);

    const jan = year2024.children.find((c) => c.name === '01');
    expect(jan).toMatchObject({ isCrate: true, path: '2024/01', imageCount: 2, status: 'up-to-date' });
    expect(jan.children).toEqual([]);
  });

  it('places a crate several directories deep at the right nesting, e.g. year/month/day', () => {
    const tree = buildOverviewTree([{ path: '2024/02/01', imageCount: 3, status: 'up-to-date' }]);

    const day = tree.children[0].children[0].children[0];
    expect(day).toMatchObject({ path: '2024/02/01', name: '01', isCrate: true });
  });

  it('treats the root itself as a crate when the whole collection is flat (no sub-collections)', () => {
    const tree = buildOverviewTree([{ path: '', imageCount: 4, status: 'up-to-date' }]);

    expect(tree).toMatchObject({ isCrate: true, path: '', imageCount: 4, status: 'up-to-date' });
    expect(tree.children).toEqual([]);
  });

  it('sums each folder\'s summary over every crate nested beneath it, at every level', () => {
    const tree = buildOverviewTree([
      { path: '2024/01', imageCount: 2, status: 'up-to-date' },
      { path: '2024/02', imageCount: 5, status: 'not-scanned' },
      { path: '2025/03', imageCount: 9, status: 'out-of-date' },
    ]);

    expect(tree.summary).toEqual({ notScanned: 1, outOfDate: 1, upToDate: 1, invalid: 0, imageCount: 16 });
    const year2024 = tree.children.find((c) => c.name === '2024');
    expect(year2024.summary).toEqual({ notScanned: 1, outOfDate: 0, upToDate: 1, invalid: 0, imageCount: 7 });
  });

  it('counts an invalid crate (a foreign or corrupt existing crate file — see buildOverview) in its own summary bucket', () => {
    const tree = buildOverviewTree([{ path: '2024/01', imageCount: 3, status: 'invalid' }]);
    const jan = tree.children[0].children[0];
    expect(jan.summary).toEqual({ notScanned: 0, outOfDate: 0, upToDate: 0, invalid: 1, imageCount: 3 });
    expect(tree.summary.invalid).toEqual(1);
  });

  it('gives a crate leaf a summary of just itself', () => {
    const tree = buildOverviewTree([{ path: '2024/01', imageCount: 2, status: 'out-of-date' }]);
    const jan = tree.children[0].children[0];
    expect(jan.summary).toEqual({ notScanned: 0, outOfDate: 1, upToDate: 0, invalid: 0, imageCount: 2 });
  });

  it('returns an empty root with no children for an empty collection', () => {
    const tree = buildOverviewTree([]);
    expect(tree).toMatchObject({ isCrate: false, children: [] });
    expect(tree.summary).toEqual({ notScanned: 0, outOfDate: 0, upToDate: 0, invalid: 0, imageCount: 0 });
  });
});
