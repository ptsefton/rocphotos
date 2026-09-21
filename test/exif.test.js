import { describe, it, expect } from 'vitest';
import { extractExif, keywordsFromExif } from '../src/core/exif.js';

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
});
