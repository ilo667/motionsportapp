import { safeEqual } from './token';

describe('safeEqual', () => {
  it('true only for the same string', () => {
    expect(safeEqual('Bearer abc123', 'Bearer abc123')).toBe(true);
    expect(safeEqual('Bearer abc123', 'Bearer abc124')).toBe(false);
  });

  it('false, not a throw, for another length or a missing value', () => {
    expect(safeEqual('Bearer abc123', 'Bearer abc')).toBe(false);
    expect(safeEqual('Bearer abc123', '')).toBe(false);
    expect(safeEqual('Bearer abc123', undefined)).toBe(false);
  });
});
