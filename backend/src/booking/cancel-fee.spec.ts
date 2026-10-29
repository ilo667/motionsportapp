import { cancelFee, halfBack } from './cancel-fee';

const H = 60 * 60 * 1000;

describe('cancel fee', () => {
  it('group: free from 2 hours before, spent under that (single or pass)', () => {
    expect(cancelFee('group', 2 * H, 1)).toBeNull();
    expect(cancelFee('group', 2 * H - 1, 1)).toBe('FULL');
    expect(cancelFee('group', 30 * 60 * 1000, 10)).toBe('FULL');
  });

  it('personal / split pass: free from a day before, one training spent under that', () => {
    expect(cancelFee('personal', 24 * H, 8)).toBeNull();
    expect(cancelFee('personal', 23 * H, 8)).toBe('FULL');
    expect(cancelFee('split', H, 6)).toBe('FULL');
  });

  it('a single personal / split training: half back from 2 hours to a day, nothing under 2 hours', () => {
    expect(cancelFee('personal', 24 * H, 1)).toBeNull();
    expect(cancelFee('split', 23 * H, 1)).toBe('HALF');
    expect(cancelFee('personal', 2 * H, 1)).toBe('HALF');
    expect(cancelFee('personal', 2 * H - 1, 1)).toBe('FULL');
  });

  it('nothing pays for it: no fee', () => {
    expect(cancelFee('group', 0, null)).toBeNull();
    expect(cancelFee('personal', H, null)).toBeNull();
  });

  it('half back in whole hryvnias', () => {
    expect(halfBack(700)).toBe(350);
    expect(halfBack(375)).toBe(187);
  });
});
