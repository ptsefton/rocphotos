import { describe, it, expect } from 'vitest';
import { renderSubCratePreview, renderRootCratePreview, earliestDate } from '../src/core/htmlPreview.js';

describe('earliestDate', () => {
  it('returns the earliest dateCreated among a set of images', () => {
    const images = [
      { dateCreated: '2025-03-10T05:00:00.000Z' },
      { dateCreated: '2025-01-02T00:00:00.000Z' },
      { dateCreated: null },
    ];
    expect(earliestDate(images)).toEqual('2025-01-02T00:00:00.000Z');
  });

  it('returns null when no image has a date', () => {
    expect(earliestDate([{ dateCreated: null }, { dateCreated: null }])).toBeNull();
  });
});

describe('renderSubCratePreview', () => {
  it('renders a thumbnail grid, using the thumbnail path when available', () => {
    const html = renderSubCratePreview({
      name: '2025-03-10',
      images: [
        { path: 'a.jpg', name: 'a.jpg', dateCreated: '2025-03-10T00:00:00.000Z', processingError: null, thumbnailPath: 'thumbnails/a.jpg.thumb.jpg' },
        { path: 'b.jpg', name: 'b.jpg', dateCreated: null, processingError: 'EXIF extraction failed: bad segment', thumbnailPath: null },
      ],
    });

    expect(html).toContain('<img src="thumbnails/a.jpg.thumb.jpg"');
    expect(html).toContain('<img src="b.jpg"'); // falls back to the full image when no thumbnail exists
    expect(html).toContain('2025-03-10');
    expect(html).toContain('EXIF extraction failed: bad segment');
  });

  it('escapes HTML-significant characters in names and error text', () => {
    const html = renderSubCratePreview({
      name: 'Album',
      images: [{ path: '<x>.jpg', name: '<x>.jpg', dateCreated: null, processingError: '<script>bad</script>', thumbnailPath: null }],
    });

    expect(html).not.toContain('<script>bad</script>');
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
  });

  it('percent-encodes filename characters that would otherwise break a file:// link', () => {
    // '#' would be read as a fragment, '?' as a query string, and '%' as an
    // existing (mis-)escape, by a browser resolving a plain relative src.
    const html = renderSubCratePreview({
      name: 'Album',
      images: [{
        path: 'sub dir/Photo #5 100% done?.jpg',
        name: 'Photo #5 100% done?.jpg',
        dateCreated: null,
        processingError: null,
        thumbnailPath: null,
      }],
    });

    expect(html).toContain('src="sub%20dir/Photo%20%235%20100%25%20done%3F.jpg"');
  });

  it('opens each thumbnail into an in-page, full-screen viewer rather than linking straight to the file', () => {
    const html = renderSubCratePreview({
      name: 'Album',
      images: [{ path: 'a.jpg', name: 'a.jpg', dateCreated: null, processingError: null, thumbnailPath: 'thumbnails/a.jpg.thumb.jpg' }],
    });

    expect(html).toContain('<a href="#viewer-0">');
    expect(html).toContain('<div id="viewer-0" class="viewer">');
    // the viewer shows the full-resolution original, not the thumbnail
    expect(html).toMatch(/<div id="viewer-0"[^]*?<img src="a\.jpg"/);
    expect(html).toContain('class="viewer-close"');
  });

  it('renders an EXIF table, inside a details element, for both the thumbnail caption and the viewer', () => {
    const html = renderSubCratePreview({
      name: 'Album',
      images: [{
        path: 'a.jpg',
        name: 'a.jpg',
        dateCreated: null,
        processingError: null,
        thumbnailPath: null,
        exifEntries: [{ name: 'Model', value: 'Pixel 6a' }],
      }],
    });

    expect(html).toMatch(/<details class="exif">[^]*?<summary>EXIF<\/summary>[^]*?<table>/);
    expect(html).toContain('<th>Model</th><td>Pixel 6a</td>');
    // appears twice: once in the thumbnail caption, once in the viewer overlay
    expect(html.match(/<th>Model<\/th><td>Pixel 6a<\/td>/g)).toHaveLength(2);
  });

  it('omits the EXIF details element entirely when there is no EXIF data', () => {
    const html = renderSubCratePreview({
      name: 'Album',
      images: [{ path: 'a.jpg', name: 'a.jpg', dateCreated: null, processingError: null, thumbnailPath: null }],
    });

    expect(html).not.toContain('class="exif"');
  });
});

describe('renderRootCratePreview', () => {
  it('groups sub-collections by year, most recent year first, and links to their preview pages', () => {
    const html = renderRootCratePreview({
      name: 'Photo Collection',
      subCrates: [
        { path: '2024/12/25', imageCount: 3, representativeDate: '2024-12-25T00:00:00.000Z' },
        { path: '2025/01/01', imageCount: 2, representativeDate: '2025-01-01T00:00:00.000Z' },
      ],
    });

    const year2025Index = html.indexOf('<h2>2025</h2>');
    const year2024Index = html.indexOf('<h2>2024</h2>');
    expect(year2025Index).toBeGreaterThan(-1);
    expect(year2024Index).toBeGreaterThan(year2025Index);
    expect(html).toContain('href="2025/01/01/ro-crate-preview.html"');
    expect(html).toContain('href="2024/12/25/ro-crate-preview.html"');
  });

  it('nests sub-collections under year then month, so a decades-long collection stays manageable', () => {
    const html = renderRootCratePreview({
      name: 'Photo Collection',
      subCrates: [
        { path: '2025/03/10', imageCount: 4, representativeDate: '2025-03-10T00:00:00.000Z' },
        { path: '2025/01/05', imageCount: 1, representativeDate: '2025-01-05T00:00:00.000Z' },
        { path: '2024/12/25', imageCount: 3, representativeDate: '2024-12-25T00:00:00.000Z' },
      ],
    });

    // Year sections, most recent first.
    const year2025 = html.indexOf('<h2>2025</h2>');
    const year2024 = html.indexOf('<h2>2024</h2>');
    expect(year2025).toBeGreaterThan(-1);
    expect(year2024).toBeGreaterThan(year2025);

    // Within 2025, month sections, most recent first, and each subcrate
    // filed under its own month rather than flattened.
    const march = html.indexOf('<summary>March</summary>');
    const january = html.indexOf('<summary>January</summary>');
    expect(march).toBeGreaterThan(year2025);
    expect(january).toBeGreaterThan(march);
    expect(html.indexOf('2025/03/10/ro-crate-preview.html')).toBeGreaterThan(march);
    expect(html.indexOf('2025/03/10/ro-crate-preview.html')).toBeLessThan(january);
    expect(html.indexOf('2025/01/05/ro-crate-preview.html')).toBeGreaterThan(january);

    // Only the most recent year and, within it, the most recent month are
    // expanded by default; everything else stays collapsed.
    expect(html).toMatch(/<details class="year" open>\s*<summary><h2>2025<\/h2>/);
    expect(html).toMatch(/<details class="year">\s*<summary><h2>2024<\/h2>/);
    expect(html).toMatch(/<details class="month" open>\s*<summary>March<\/summary>/);
    expect(html).toMatch(/<details class="month">\s*<summary>January<\/summary>/);
  });

  it('lists sub-collections with no dated images under an Undated section', () => {
    const html = renderRootCratePreview({
      name: 'Photo Collection',
      subCrates: [{ path: 'misc', imageCount: 1, representativeDate: null }],
    });

    expect(html).toContain('<h2>Undated</h2>');
    expect(html).toContain('href="misc/ro-crate-preview.html"');
  });
});
