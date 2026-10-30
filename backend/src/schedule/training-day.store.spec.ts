import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { trainingDayOn } from './training-day.store';

// Keeps the WHERE condition so the test can check which day was asked for
function makeDb(rows: unknown[]) {
  const where: SQL[] = [];
  const chain: any = { then: (resolve: (v: unknown) => void) => resolve(rows) };
  chain.from = jest.fn(() => chain);
  chain.limit = jest.fn(() => chain);
  chain.where = jest.fn((cond: SQL) => (where.push(cond), chain));
  return { db: { select: jest.fn(() => chain) } as any, where };
}

describe('trainingDayOn — the training day row of a date', () => {
  it('asks for that date and returns its row', async () => {
    const day = { id: 'day-1', localDate: '2026-10-27', status: 'SCHEDULED' };
    const { db, where } = makeDb([day]);
    await expect(trainingDayOn(db, '2026-10-27')).resolves.toEqual(day);
    const { sql, params } = new PgDialect().sqlToQuery(where[0]);
    expect(sql).toBe('"training_days"."local_date" = $1');
    expect(params).toEqual(['2026-10-27']);
  });

  it('null when the date has no row', async () => {
    await expect(trainingDayOn(makeDb([]).db, '2026-10-28')).resolves.toBeNull();
  });
});
