import { describe, it, expect } from 'vitest';
import { correctAreaForOrientation } from '../src/core/faces/orientation.js';

const area = { x: 0.7, y: 0.3, w: 0.1, h: 0.2 };

describe('correctAreaForOrientation', () => {
  it('is a no-op for normal orientation, an unknown string, or none at all', () => {
    expect(correctAreaForOrientation(area, 'Horizontal (normal)')).toEqual(area);
    expect(correctAreaForOrientation(area, 'Something exifr has never returned')).toEqual(area);
    expect(correctAreaForOrientation(area, undefined)).toEqual(area);
  });

  it('mirrors horizontally', () => {
    const result = correctAreaForOrientation(area, 'Mirror horizontal');
    expect(result.x).toBeCloseTo(0.3, 10);
    expect(result).toMatchObject({ y: 0.3, w: 0.1, h: 0.2 });
  });

  it('rotates 180', () => {
    const result = correctAreaForOrientation(area, 'Rotate 180');
    expect(result.x).toBeCloseTo(0.3, 10);
    expect(result).toMatchObject({ y: 0.7, w: 0.1, h: 0.2 });
  });

  it('mirrors vertically', () => {
    expect(correctAreaForOrientation(area, 'Mirror vertical')).toEqual({ x: 0.7, y: 0.7, w: 0.1, h: 0.2 });
  });

  it('rotates 90 CW, swapping the box\'s width and height fractions', () => {
    expect(correctAreaForOrientation(area, 'Rotate 90 CW')).toEqual({ x: 0.7, y: 0.7, w: 0.2, h: 0.1 });
  });

  it('rotates 270 CW — confirmed against a real digiKam-tagged file\'s actual detected face position', () => {
    // The real file: Area {X: 0.68799, Y: 0.33919}, Orientation "Rotate
    // 270 CW". face-api.js independently detected the same face at
    // roughly (0.332, 0.326) in the browser-decoded (rotated) frame —
    // matching this transform's output to within the detector's own
    // bounding-box imprecision.
    const real = { x: 0.68799, y: 0.33919, w: 0.09277, h: 0.1237 };
    const corrected = correctAreaForOrientation(real, 'Rotate 270 CW');
    expect(corrected.x).toBeCloseTo(0.339, 2);
    expect(corrected.y).toBeCloseTo(0.312, 2);
    expect(corrected.w).toEqual(real.h);
    expect(corrected.h).toEqual(real.w);
  });

  it('is its own inverse composed with a 180 for the two mirrored-and-rotated cases (5 and 7), and self-consistent with plain rotation for 6/8', () => {
    // Applying 90 CW then 270 CW should return to the original area.
    const rotated = correctAreaForOrientation(area, 'Rotate 90 CW');
    const back = correctAreaForOrientation(rotated, 'Rotate 270 CW');
    expect(back.x).toBeCloseTo(area.x, 10);
    expect(back.y).toBeCloseTo(area.y, 10);
    expect(back.w).toBeCloseTo(area.w, 10);
    expect(back.h).toBeCloseTo(area.h, 10);
  });
});
