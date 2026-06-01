import { describe, it, expect } from 'vitest';
import { PKG } from './index.js';

describe('@helm/replay', () => {
  it('should export the package name', () => {
    expect(PKG).toBe('@helm/replay');
  });
});
