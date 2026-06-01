import { describe, it, expect } from 'vitest';
import { PKG } from './index.js';

describe('@helm/eval', () => {
  it('should export the package name', () => {
    expect(PKG).toBe('@helm/eval');
  });
});
