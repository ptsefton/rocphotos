import { describe, it, expect } from 'vitest';
import { boxOverlapRatio, centerAreaToTopLeftBox, SAME_FACE_OVERLAP_THRESHOLD, bestOverlapEitherOrientation } from '../src/core/faces/geometry.js';

describe('centerAreaToTopLeftBox', () => {
  it('converts an MWG center-based Area to a top-left box of the same size', () => {
    const box = centerAreaToTopLeftBox({ x: 0.5, y: 0.4, w: 0.2, h: 0.1 });
    expect(box.x).toBeCloseTo(0.4, 10);
    expect(box.y).toBeCloseTo(0.35, 10);
    expect(box).toMatchObject({ w: 0.2, h: 0.1 });
  });
});

describe('boxOverlapRatio', () => {
  it('is 1 for identical boxes', () => {
    const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    expect(boxOverlapRatio(box, box)).toBeCloseTo(1, 10);
  });

  it('is 0 for boxes that do not touch at all', () => {
    expect(boxOverlapRatio({ x: 0, y: 0, w: 0.1, h: 0.1 }, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 })).toEqual(0);
  });

  it('is a fraction between 0 and 1 for partially overlapping boxes', () => {
    // Two identical-size boxes offset by half their width/height overlap
    // on a quarter of their combined area each, giving IoU = overlap /
    // (area + area - overlap) = 0.25 / (1 + 1 - 0.25) = 1/7.
    const a = { x: 0, y: 0, w: 0.2, h: 0.2 };
    const b = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    expect(boxOverlapRatio(a, b)).toBeCloseTo(1 / 7, 5);
  });

  it('treats a real detected-box-vs-tagged-region pair (roughly aligned, not pixel-identical) as the same face', () => {
    // A fresh face-api.js detection and an MWG region drawn by a
    // different tool rarely agree exactly — this is the actual scenario
    // the overlap check exists for (see handler.js's /detections route).
    const detected = { x: 0.30, y: 0.25, w: 0.12, h: 0.14 };
    const tagged = { x: 0.28, y: 0.27, w: 0.13, h: 0.13 };
    expect(boxOverlapRatio(detected, tagged)).toBeGreaterThanOrEqual(SAME_FACE_OVERLAP_THRESHOLD);
  });
});

describe('bestOverlapEitherOrientation', () => {
  // Real, empirically-confirmed values (see Spec.md's Face Recognition
  // section): an Apple Photos-tagged file with Orientation "Rotate 90
  // CW", whose Area is measured against the already-oriented display
  // frame — applying the (correct, for digiKam) orientation correction
  // to it moves the box somewhere else in the photo, and a fresh
  // face-api.js detection then no longer overlaps it at all.
  const detectedBox = { x: 0.36178652445475257, y: 0.23923218250274658, w: 0.15869951248168945, h: 0.16543585062026978 };
  const rawArea = { x: 0.4411362806955973, y: 0.32195010781288147, w: 0.15869951248168945, h: 0.16543585062026978 };

  it('finds the match via the raw area when the orientation-corrected one misses entirely', () => {
    const wronglyCorrectedArea = { x: 0.1, y: 0.1, w: 0.15869951248168945, h: 0.16543585062026978 };
    const overlap = bestOverlapEitherOrientation(detectedBox, rawArea, wronglyCorrectedArea);
    expect(overlap).toBeGreaterThanOrEqual(SAME_FACE_OVERLAP_THRESHOLD);
  });

  it('finds the match via the corrected area when the raw one misses entirely (the digiKam case)', () => {
    const wrongRawArea = { x: 0.1, y: 0.1, w: 0.09277, h: 0.1237 };
    // The center-based Area that, once converted to top-left, is exactly
    // detectedBox — i.e. this interpretation is the correct one.
    const correctedArea = { x: detectedBox.x + detectedBox.w / 2, y: detectedBox.y + detectedBox.h / 2, w: detectedBox.w, h: detectedBox.h };
    const overlap = bestOverlapEitherOrientation(detectedBox, wrongRawArea, correctedArea);
    expect(overlap).toBeGreaterThanOrEqual(SAME_FACE_OVERLAP_THRESHOLD);
  });

  it('is 0 when neither interpretation is anywhere near the detected box', () => {
    const overlap = bestOverlapEitherOrientation(detectedBox, { x: 0.9, y: 0.9, w: 0.05, h: 0.05 }, { x: 0.9, y: 0.1, w: 0.05, h: 0.05 });
    expect(overlap).toEqual(0);
  });
});
