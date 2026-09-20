import { describe, it, expect } from 'vitest';
import { isImageFile, mediaTypeFor } from '../src/core/imageTypes.js';

describe('isImageFile', () => {
  it('recognises known image extensions, case-insensitively', () => {
    expect(isImageFile('photo.jpg')).toBe(true);
    expect(isImageFile('PHOTO.JPG')).toBe(true);
    expect(isImageFile('scan.tiff')).toBe(true);
  });

  it('rejects non-image files and extensionless names', () => {
    expect(isImageFile('notes.txt')).toBe(false);
    expect(isImageFile('README')).toBe(false);
  });
});

describe('mediaTypeFor', () => {
  it('maps known extensions to their media type', () => {
    expect(mediaTypeFor('photo.jpg')).toEqual('image/jpeg');
    expect(mediaTypeFor('photo.JPEG')).toEqual('image/jpeg');
    expect(mediaTypeFor('scan.tiff')).toEqual('image/tiff');
  });

  it('falls back to a generic media type for unknown extensions', () => {
    expect(mediaTypeFor('notes.txt')).toEqual('application/octet-stream');
    expect(mediaTypeFor('README')).toEqual('application/octet-stream');
  });
});
