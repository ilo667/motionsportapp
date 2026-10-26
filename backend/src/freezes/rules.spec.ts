import { daysBetween, frozenOn, isOpen, plusDays } from './rules';

const active = { status: 'ACTIVE', startedOn: '2026-10-26', endsOn: '2026-11-25' };

describe('freeze rules', () => {
  it('frozen from the start day up to the day before ends_on', () => {
    expect(frozenOn(active, '2026-10-25')).toBe(false);
    expect(frozenOn(active, '2026-10-26')).toBe(true);
    expect(frozenOn(active, '2026-11-24')).toBe(true);
    expect(frozenOn(active, '2026-11-25')).toBe(false);
  });

  it('a request, a rejected or a cancelled freeze freezes nothing', () => {
    for (const status of ['REQUESTED', 'REJECTED', 'CANCELLED']) {
      expect(frozenOn({ ...active, status }, '2026-11-01')).toBe(false);
    }
  });

  it('an unfreeze on the start day freezes nothing', () => {
    expect(frozenOn({ ...active, endsOn: '2026-10-26' }, '2026-10-26')).toBe(false);
  });

  it('open: a request, or an approved freeze not over yet', () => {
    expect(isOpen({ status: 'REQUESTED', startedOn: null, endsOn: null }, '2026-10-26')).toBe(true);
    expect(isOpen(active, '2026-11-24')).toBe(true);
    expect(isOpen(active, '2026-11-25')).toBe(false);
    expect(isOpen({ ...active, status: 'REJECTED' }, '2026-10-26')).toBe(false);
  });

  it('days count calendar days, across the DST switch and month ends', () => {
    expect(plusDays('2026-10-24', 30)).toBe('2026-11-23');
    expect(plusDays('2026-01-31', 30)).toBe('2026-03-02');
    expect(plusDays('2026-11-25', -1)).toBe('2026-11-24');
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2); // 25.10 is the DST switch in Kyiv
    expect(daysBetween('2026-10-26', '2026-11-25')).toBe(30);
  });
});
