import { describe, it, expect } from 'vitest';
import { thumbnailPathFor, THUMBNAILS_DIR_NAME } from '../src/core/thumbnails.js';

describe('thumbnailPathFor', () => {
  it('places the thumbnail under the thumbnails directory, preserving the source path and extension', () => {
    expect(thumbnailPathFor('2025-03-10 12.53.17.jpg')).toEqual(`${THUMBNAILS_DIR_NAME}/2025-03-10 12.53.17.jpg.thumb.jpg`);
  });

  it('preserves nested source directories under the thumbnails root', () => {
    expect(thumbnailPathFor('sub/dir/photo.png')).toEqual(`${THUMBNAILS_DIR_NAME}/sub/dir/photo.png.thumb.jpg`);
  });
});
