import { describe, it, expect } from 'vitest';
import { frontalRatio, isReliableForMatching, MIN_FACE_SIZE_PX, MIN_FRONTAL_RATIO } from '../webview/faceQuality.js';

function landmarks({ noseX, leftEyeX, rightEyeX }) {
  return {
    getNose: () => [{ x: noseX }],
    getLeftEye: () => [{ x: leftEyeX }],
    getRightEye: () => [{ x: rightEyeX }],
  };
}

function detectionResult({ width = MIN_FACE_SIZE_PX + 1, height = MIN_FACE_SIZE_PX + 1, ...eyeArgs }) {
  return { detection: { box: { width, height } }, landmarks: landmarks(eyeArgs) };
}

describe('frontalRatio', () => {
  it('is 1 for a perfectly symmetric (frontal) face', () => {
    expect(frontalRatio(landmarks({ noseX: 50, leftEyeX: 30, rightEyeX: 70 }))).toEqual(1);
  });

  it('is close to 0 for a strong profile turn (nose almost under one eye)', () => {
    const ratio = frontalRatio(landmarks({ noseX: 32, leftEyeX: 30, rightEyeX: 70 }));
    expect(ratio).toBeLessThan(0.1);
  });

  it('is between 0 and 1 for a mild, everyday head tilt', () => {
    const ratio = frontalRatio(landmarks({ noseX: 45, leftEyeX: 30, rightEyeX: 70 }));
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(1);
  });
});

describe('isReliableForMatching', () => {
  it('accepts a large, frontal detection', () => {
    expect(isReliableForMatching(detectionResult({ noseX: 50, leftEyeX: 30, rightEyeX: 70 }))).toBe(true);
  });

  it('rejects a detection smaller than MIN_FACE_SIZE_PX, even if frontal', () => {
    const result = detectionResult({ width: MIN_FACE_SIZE_PX - 1, noseX: 50, leftEyeX: 30, rightEyeX: 70 });
    expect(isReliableForMatching(result)).toBe(false);
  });

  it('rejects a strong profile turn, even if large', () => {
    const result = detectionResult({ noseX: 32, leftEyeX: 30, rightEyeX: 70 });
    expect(frontalRatio(result.landmarks)).toBeLessThan(MIN_FRONTAL_RATIO);
    expect(isReliableForMatching(result)).toBe(false);
  });
});
