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

describe('viewer navigation', () => {
  const threeImages = () => renderSubCratePreview({
    name: 'Album',
    images: ['a.jpg', 'b.jpg', 'c.jpg'].map((name) => ({
      path: name, name, dateCreated: null, processingError: null, thumbnailPath: null,
    })),
  });

  it('links each viewer to its neighbours, so a photo can be stepped through without script', () => {
    const html = threeImages();
    const middle = html.slice(html.indexOf('id="viewer-1"'), html.indexOf('id="viewer-2"'));

    expect(middle).toContain('href="#viewer-0"');
    expect(middle).toContain('href="#viewer-2"');
    expect(middle).toContain('2 of 3');
  });

  it('gives the first and last a dimmed non-link, so the controls do not shift between photos', () => {
    const html = threeImages();
    const first = html.slice(html.indexOf('id="viewer-0"'), html.indexOf('id="viewer-1"'));
    const last = html.slice(html.indexOf('id="viewer-2"'));

    expect(first).toContain('<span class="viewer-nav viewer-prev is-disabled"');
    expect(first).toContain('href="#viewer-1"');
    expect(last).toContain('<span class="viewer-nav viewer-next is-disabled"');
    expect(last).toContain('href="#viewer-1"');
  });

  it('puts a full-bleed link behind the photo, so clicking away from it returns to the grid', () => {
    const html = threeImages();
    const first = html.slice(html.indexOf('id="viewer-0"'), html.indexOf('id="viewer-1"'));

    expect(first).toContain('<a class="viewer-backdrop" href="#"');
    // ...and the photo itself sits above it, so clicking the photo does not close.
    expect(first).toContain('<div class="viewer-content">');
    expect(html).toContain('.viewer-backdrop { position: absolute; inset: 0;');
    expect(html).toContain('.viewer-content {');
  });

  it('still needs no script for any of it', () => {
    // The people browser's search is the only script these pages carry;
    // an album with nobody in it should have none at all.
    expect(threeImages()).not.toContain('<script>');
  });
});

describe('people browser', () => {
  const twoPeopleCrate = () => renderSubCratePreview({
    name: '2025-03-10',
    images: [
      { path: 'a.jpg', name: 'a.jpg', dateCreated: '2025-03-10T00:00:00.000Z', processingError: null, thumbnailPath: 'thumbnails/a.jpg.thumb.jpg', people: ['Jane Smith', 'Bob Jones'] },
      { path: 'b.jpg', name: 'b.jpg', dateCreated: null, processingError: null, thumbnailPath: 'thumbnails/b.jpg.thumb.jpg', people: ['Jane Smith'] },
      { path: 'c.jpg', name: 'c.jpg', dateCreated: null, processingError: null, thumbnailPath: null, people: [] },
    ],
  });

  it('lists everyone depicted, in name order, with their own photo count', () => {
    const html = twoPeopleCrate();
    expect(html).toContain('<h2>People</h2>');
    expect(html.indexOf('data-name="Bob Jones"')).toBeLessThan(html.indexOf('data-name="Jane Smith"'));
    expect(html).toMatch(/data-name="Jane Smith"><span>Jane Smith<\/span><span class="count">2<\/span>/);
    expect(html).toMatch(/data-name="Bob Jones"><span>Bob Jones<\/span><span class="count">1<\/span>/);
  });

  it('gives each person a panel of their own photos, opened by a radio the list label checks', () => {
    const html = twoPeopleCrate();
    // Bob Jones sorts first, so he is person-0.
    expect(html).toContain('<input type="radio" name="person-panel" id="person-0" class="person-radio" />');
    expect(html).toContain('<label for="person-0"');
    expect(html).toContain('<div class="person-panel" id="person-photos-0">');
    expect(html).toContain('#person-0:checked ~ .person-panels > #person-photos-0 { display: block; }');
    // Closing is a label for the always-present "nobody" radio.
    expect(html).toContain('<input type="radio" name="person-panel" id="person-none" class="person-radio" checked />');
    expect(html).toContain('<label for="person-none" class="person-panel-close"');
  });

  it('points a person\'s photos at the same in-page viewers the main grid already uses', () => {
    const html = twoPeopleCrate();
    const panelStart = html.indexOf('id="person-photos-1"'); // Jane Smith
    const panel = html.slice(panelStart, html.indexOf('</div>', html.indexOf('</figure>', panelStart)));
    expect(panel).toContain('href="#viewer-0"'); // a.jpg
    expect(panel).toContain('href="#viewer-1"'); // b.jpg
    expect(panel).not.toContain('href="#viewer-2"'); // c.jpg depicts nobody
  });

  it('leaves the browser out entirely when nobody is depicted', () => {
    const html = renderSubCratePreview({
      name: 'Album',
      images: [{ path: 'a.jpg', name: 'a.jpg', dateCreated: null, processingError: null, thumbnailPath: null }],
    });
    // The shared stylesheet always carries the rules; what must be
    // absent is any of the markup they would style.
    expect(html).not.toContain('<div class="people-browser">');
    expect(html).not.toContain('<input type="radio" name="person-panel"');
    expect(html).not.toContain('<div class="person-panel"');
    expect(html).not.toContain('<script>');
  });

  it("opens each of a person's photos in a viewer that steps through that person's own set", () => {
    const html = renderRootCratePreview({
      name: 'Photo Collection',
      subCrates: [{ path: '2025/03/10', imageCount: 3, representativeDate: '2025-03-10T00:00:00.000Z' }],
      people: [{
        name: 'Jane Smith',
        total: 3,
        images: ['a.jpg', 'b.jpg', 'c.jpg'].map((name) => ({
          path: `2025/03/10/${name}`,
          thumbnailPath: `2025/03/10/thumbnails/${name}.thumb.jpg`,
          name,
          subCollection: '2025/03/10',
        })),
      }],
    });

    expect(html).toContain('data-name="Jane Smith"');
    // The thumbnail opens a viewer rather than linking away to the file.
    expect(html).toContain('<img src="2025/03/10/thumbnails/a.jpg.thumb.jpg"');
    expect(html).toContain('href="#person-0-photo-0"');
    expect(html).toContain('<div id="person-0-photo-0" class="viewer">');

    // Next/previous stay within this person's photos, and the viewer
    // shows the full-size image rather than the thumbnail.
    const middle = html.slice(html.indexOf('id="person-0-photo-1"'), html.indexOf('id="person-0-photo-2"'));
    expect(middle).toContain('<img src="2025/03/10/b.jpg"');
    expect(middle).toContain('href="#person-0-photo-0"');
    expect(middle).toContain('href="#person-0-photo-2"');
    expect(middle).toContain('2 of 3');
    // ...and clicking away from the photo closes it, as on a sub-collection page.
    expect(middle).toContain('<a class="viewer-backdrop" href="#"');
  });

  it('lists every photo of a person rather than a sample, in a grid that scrolls', () => {
    const images = Array.from({ length: 40 }, (unused, i) => ({
      path: `2025/03/10/p${i}.jpg`,
      thumbnailPath: `2025/03/10/thumbnails/p${i}.jpg.thumb.jpg`,
      name: `p${i}.jpg`,
      subCollection: '2025/03/10',
    }));
    const html = renderRootCratePreview({
      name: 'Photo Collection',
      subCrates: [],
      people: [{ name: 'Jane Smith', total: 40, images }],
    });

    expect(html).toContain('id="person-0-photo-39"');
    expect(html).toContain('40 photos');
    expect(html).not.toContain('showing ');
    // The panel's own grid scrolls, and every thumbnail defers its bytes.
    expect(html).toContain('class="grid person-panel-grid"');
    expect(html).toContain('.person-panel-grid { max-height:');
    expect(html.match(/loading="lazy"/g).length).toBeGreaterThanOrEqual(80);
  });

  it('escapes a person name everywhere it is used', () => {
    const html = renderSubCratePreview({
      name: 'Album',
      images: [{ path: 'a.jpg', name: 'a.jpg', dateCreated: null, processingError: null, thumbnailPath: null, people: ['<script>x</script>'] }],
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});
