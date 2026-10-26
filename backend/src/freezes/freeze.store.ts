import { and, desc, inArray } from 'drizzle-orm';
import { freezes } from '../database/schema';
import type { DatabaseService } from '../database/database.service';
import { frozenOn, isOpen } from './rules';

type Db = DatabaseService['db'];
type Q = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

// Members' requested and approved freezes, newest first. A plain function (like getMemberTrainerId), so booking,
// admin and entitlements code read it without a module cycle
export async function loadFreezes(db: Q, memberIds: string[]) {
  if (memberIds.length === 0) return [];
  return db
    .select({
      id: freezes.id,
      memberId: freezes.memberId,
      status: freezes.status,
      startedOn: freezes.startedOn,
      endsOn: freezes.endsOn,
      requestedAt: freezes.requestedAt,
      unfreezeRequestedAt: freezes.unfreezeRequestedAt,
    })
    .from(freezes)
    .where(and(inArray(freezes.memberId, memberIds), inArray(freezes.status, ['REQUESTED', 'ACTIVE'])))
    .orderBy(desc(freezes.requestedAt));
}

export type FreezeRow = Awaited<ReturnType<typeof loadFreezes>>[number];

export async function memberFrozenOn(db: Q, memberId: string, date: string) {
  return (await loadFreezes(db, [memberId])).some((f) => frozenOn(f, date));
}

// The freeze in the way of a new request, if any (one at a time)
export async function openFreeze(db: Q, memberId: string, today: string) {
  return (await loadFreezes(db, [memberId])).find((f) => isOpen(f, today)) ?? null;
}
