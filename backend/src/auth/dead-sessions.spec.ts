import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { deleteDeadSessions } from './dead-sessions';
import { sessions } from '../database/schema';

describe('deleteDeadSessions', () => {
  it('deletes the sessions expired or ended more than 30 days ago', async () => {
    const where: SQL[] = [];
    const del = jest.fn(() => ({ where: (cond: SQL) => (where.push(cond), Promise.resolve()) }));
    const now = new Date('2026-10-27T10:00:00Z');
    await deleteDeadSessions({ delete: del } as any, now);

    expect(del).toHaveBeenCalledWith(sessions);
    const { sql, params } = new PgDialect().sqlToQuery(where[0]);
    expect(sql).toBe('("sessions"."expires_at" < $1 or "sessions"."revoked_at" < $2)');
    expect(params).toEqual(['2026-09-27T10:00:00.000Z', '2026-09-27T10:00:00.000Z']);
  });
});
