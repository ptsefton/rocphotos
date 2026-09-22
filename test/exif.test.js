import { describe, it, expect } from 'vitest';
import { extractExif, keywordsFromExif, ratingFromExif, regionsFromExif, titleFromExif, descriptionFromExif } from '../src/core/exif.js';

describe('extractExif', () => {
  it('never throws, even for bytes that are not a recognisable image', async () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const result = await extractExif(junk);
    expect(result).toHaveProperty('exif');
    expect(result).toHaveProperty('error');
  });

  it('returns a null exif with no error for a well-formed image lacking EXIF data', async () => {
    // Minimal 1x1 PNG: no EXIF segment, but not malformed either.
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const bytes = Uint8Array.from(Buffer.from(pngBase64, 'base64'));

    const result = await extractExif(bytes);
    expect(result.error).toBeNull();
  });
});

describe('keywordsFromExif', () => {
  it('flattens a hierarchical entry ("Parent|Child") into both terms independently', () => {
    // Real-world shape, confirmed against files tagged in Lightroom
    // Classic: a photo tagged with the specific term "Nankeen Kestrel"
    // under the broader term "Bird" produces one hierarchicalSubject
    // entry "Bird|Nankeen Kestrel", alongside standalone entries.
    const exif = { hierarchicalSubject: ['Background', 'Bird|Nankeen Kestrel', 'Lithgow Blast Furnace'] };
    expect(keywordsFromExif(exif).sort()).toEqual(['Background', 'Bird', 'Lithgow Blast Furnace', 'Nankeen Kestrel']);
  });

  it('prefers hierarchicalSubject, then subject, then Keywords', () => {
    expect(keywordsFromExif({ hierarchicalSubject: ['A'], subject: ['B'], Keywords: ['C'] })).toEqual(['A']);
    expect(keywordsFromExif({ subject: ['B'], Keywords: ['C'] })).toEqual(['B']);
    expect(keywordsFromExif({ Keywords: ['C'] })).toEqual(['C']);
  });

  it('handles a single-keyword file where exifr returns a plain string rather than an array', () => {
    expect(keywordsFromExif({ Keywords: 'Peter Malcolm Sefton' })).toEqual(['Peter Malcolm Sefton']);
  });

  it('de-duplicates terms that appear both standalone and as part of a hierarchy', () => {
    const exif = { hierarchicalSubject: ['Bird', 'Bird|Nankeen Kestrel'] };
    expect(keywordsFromExif(exif)).toEqual(['Bird', 'Nankeen Kestrel']);
  });

  it('trims whitespace around each hierarchy level', () => {
    expect(keywordsFromExif({ Keywords: [' Bird | Nankeen Kestrel '] })).toEqual(['Bird', 'Nankeen Kestrel']);
  });

  it('returns an empty array when no keyword field is present, or exif is null', () => {
    expect(keywordsFromExif({ Make: 'Google' })).toEqual([]);
    expect(keywordsFromExif(null)).toEqual([]);
  });

  it('decodes XML character references left un-decoded by exifr (see regionsFromExif)', () => {
    expect(keywordsFromExif({ Keywords: ["Kirra&#39;s Beach"] })).toEqual(["Kirra's Beach"]);
  });
});

describe('ratingFromExif', () => {
  it('returns the star rating when it is 1 or higher', () => {
    expect(ratingFromExif({ Rating: 5 })).toEqual(5);
    expect(ratingFromExif({ Rating: 1 })).toEqual(1);
  });

  it('treats a rating of 0 as absent, since tools such as Lightroom write it on every photo they touch, not only starred ones', () => {
    expect(ratingFromExif({ Rating: 0 })).toBeNull();
  });

  it('returns null when there is no Rating field, or exif is null', () => {
    expect(ratingFromExif({ Make: 'Google' })).toBeNull();
    expect(ratingFromExif(null)).toBeNull();
  });
});

describe('regionsFromExif', () => {
  it('reads a single named face region, with no area when none was recorded', () => {
    const exif = { Regions: { RegionList: { Name: 'Peter Malcolm Sefton', Type: 'Face' } } };
    expect(regionsFromExif(exif)).toEqual([{ name: 'Peter Malcolm Sefton', type: 'Face', area: null }]);
  });

  it('reads the region\'s fractional bounding box when present', () => {
    const exif = {
      Regions: {
        RegionList: { Name: 'Peter Malcolm Sefton', Type: 'Face', Area: { x: 0.57, y: 0.23, w: 0.29, h: 0.27 } },
      },
    };
    expect(regionsFromExif(exif)).toEqual([
      { name: 'Peter Malcolm Sefton', type: 'Face', area: { x: 0.57, y: 0.23, w: 0.29, h: 0.27 } },
    ]);
  });

  it('reads several regions when RegionList is an array, keeping face and pet apart', () => {
    const exif = {
      Regions: {
        RegionList: [
          { Name: 'Gail McGlinn', Type: 'Face' },
          { Name: 'Rex', Type: 'Pet' },
        ],
      },
    };
    expect(regionsFromExif(exif)).toEqual([
      { name: 'Gail McGlinn', type: 'Face', area: null },
      { name: 'Rex', type: 'Pet', area: null },
    ]);
  });

  it('ignores an unnamed region (a detected but unidentified face)', () => {
    const exif = { Regions: { RegionList: { Type: 'Face' } } };
    expect(regionsFromExif(exif)).toEqual([]);
  });

  it('ignores a region of a type other than Face or Pet', () => {
    const exif = { Regions: { RegionList: { Name: 'Something', Type: 'Focus' } } };
    expect(regionsFromExif(exif)).toEqual([]);
  });

  it('returns an empty array when there are no regions, or exif is null', () => {
    expect(regionsFromExif({ Make: 'Google' })).toEqual([]);
    expect(regionsFromExif(null)).toEqual([]);
  });

  it('decodes an XML character reference exifr leaves un-decoded in a region Name', () => {
    // Confirmed against a real file: exifr does not decode entities
    // inside this nested XMP struct field, even though the raw XMP is
    // valid, standard-escaped XML — a name with an apostrophe round-
    // trips through a real exiftool write/read as the literal text
    // "Alana Mahon&#39;s Daughter" rather than "Alana Mahon's Daughter".
    const exif = { Regions: { RegionList: { Name: 'Alana Mahon&#39;s Daughter', Type: 'Face' } } };
    expect(regionsFromExif(exif)[0].name).toEqual("Alana Mahon's Daughter");
  });
});

describe('titleFromExif', () => {
  it('reads a plain-string IPTC ObjectName', () => {
    expect(titleFromExif({ ObjectName: 'Sunset over the lake' })).toEqual('Sunset over the lake');
  });

  it('reads an XMP dc:title expressed as a {lang, value} pair', () => {
    expect(titleFromExif({ title: { lang: 'x-default', value: 'Sunset over the lake' } })).toEqual('Sunset over the lake');
  });

  it('prefers ObjectName over title when both are present', () => {
    expect(titleFromExif({ ObjectName: 'IPTC title', title: 'XMP title' })).toEqual('IPTC title');
  });

  it('returns null when there is no title field, or exif is null', () => {
    expect(titleFromExif({ Make: 'Google' })).toBeNull();
    expect(titleFromExif(null)).toBeNull();
  });

  it('decodes XML character references left un-decoded by exifr (see regionsFromExif)', () => {
    expect(titleFromExif({ ObjectName: 'Rock &amp; Roll Museum' })).toEqual('Rock & Roll Museum');
  });
});

describe('descriptionFromExif', () => {
  it('reads a plain-string IPTC caption (exifr\'s own "Caption" key for Caption-Abstract)', () => {
    expect(descriptionFromExif({ Caption: 'A heron at the lake' })).toEqual('A heron at the lake');
  });

  it('reads an XMP dc:description expressed as a {lang, value} pair, confirmed against a real file', () => {
    expect(descriptionFromExif({ description: { lang: 'x-default', value: 'OLYMPUS DIGITAL CAMERA' } })).toEqual('OLYMPUS DIGITAL CAMERA');
  });

  it('picks the x-default entry when several languages are present', () => {
    const description = [{ lang: 'fr', value: 'Bonjour' }, { lang: 'x-default', value: 'Hello' }];
    expect(descriptionFromExif({ description })).toEqual('Hello');
  });

  it('returns null when there is no description field, or exif is null', () => {
    expect(descriptionFromExif({ Make: 'Google' })).toBeNull();
    expect(descriptionFromExif(null)).toBeNull();
  });
});
