import { cancelFee, halfBack } from './cancel-fee';

const H = 60 * 60 * 1000;

describe('cancel fee', () => {
  it('group: free from 2 hours before, spent under that (single or pass)', () => {
    expect(cancelFee('групові', 2 * H, 1)).toBeNull();
    expect(cancelFee('групові', 2 * H - 1, 1)).toBe('FULL');
    expect(cancelFee('групові', 30 * 60 * 1000, 10)).toBe('FULL');
  });

  it('personal / split pass: free from a day before, one training spent under that', () => {
    expect(cancelFee('персональні', 24 * H, 8)).toBeNull();
    expect(cancelFee('персональні', 23 * H, 8)).toBe('FULL');
    expect(cancelFee('спліт', H, 6)).toBe('FULL');
  });

  it('a single personal / split training: half back from 2 hours to a day, nothing under 2 hours', () => {
    expect(cancelFee('персональні', 24 * H, 1)).toBeNull();
    expect(cancelFee('спліт', 23 * H, 1)).toBe('HALF');
    expect(cancelFee('персональні', 2 * H, 1)).toBe('HALF');
    expect(cancelFee('персональні', 2 * H - 1, 1)).toBe('FULL');
  });

  it('nothing pays for it: no fee', () => {
    expect(cancelFee('групові', 0, null)).toBeNull();
    expect(cancelFee('персональні', H, null)).toBeNull();
  });

  it('half back in whole hryvnias', () => {
    expect(halfBack(700)).toBe(350);
    expect(halfBack(375)).toBe(187);
  });
});
