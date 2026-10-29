import { revenueKey, summarizeLoad } from './stats.service';

describe('stats — revenue columns', () => {
  it('club cards, group passes, and trainer services by type', () => {
    expect(revenueKey('club_card', null)).toBe('clubCards');
    expect(revenueKey('group', 'group')).toBe('group');
    expect(revenueKey('assigned', 'personal')).toBe('personal');
    expect(revenueKey('assigned', 'split')).toBe('split');
  });
});

describe('stats — load', () => {
  // Mon 19.10, Wed 21.10, Mon 26.10 (nobody came), Fri 23.10
  const present = new Map([
    ['2026-10-19', 6],
    ['2026-10-21', 9],
    ['2026-10-23', 4],
    ['2026-10-26', 0],
  ]);

  it('busiest days: most ✓ first, days nobody came left out', () => {
    expect(summarizeLoad(present).busiestDays).toEqual([
      { localDate: '2026-10-21', present: 9 },
      { localDate: '2026-10-19', present: 6 },
      { localDate: '2026-10-23', present: 4 },
    ]);
  });

  it('a tie: the later day first', () => {
    const tie = new Map([
      ['2026-10-19', 5],
      ['2026-10-21', 5],
    ]);
    expect(summarizeLoad(tie).busiestDays.map((d) => d.localDate)).toEqual(['2026-10-21', '2026-10-19']);
  });

  it('weekday average counts the days nobody came', () => {
    expect(summarizeLoad(present).weekdays).toEqual([
      { weekday: 1, days: 2, avgPresent: 3 },
      { weekday: 3, days: 1, avgPresent: 9 },
      { weekday: 5, days: 1, avgPresent: 4 },
    ]);
  });

  it('only the top 5', () => {
    const many = new Map(Array.from({ length: 8 }, (_, i) => [`2026-10-${10 + i}`, i + 1] as [string, number]));
    expect(summarizeLoad(many).busiestDays).toHaveLength(5);
  });
});
