import { NotFoundException } from '@nestjs/common';
import { and, asc, eq, getTableColumns, isNull, or } from 'drizzle-orm';
import { admins, members, trainingDays, trainingSlots } from '../database/schema';
import type { DatabaseService } from '../database/database.service';
import { apiError } from '../common/api-error';

type Db = DatabaseService['db'];
type Q = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

// The first trainer account: owns LEGACY_DEFAULT and members without a trainer
export async function getDefaultTrainerId(db: Q): Promise<string | null> {
  const [trainer] = await db.select({ id: admins.id }).from(admins).orderBy(asc(admins.createdAt)).limit(1);
  return trainer?.id ?? null;
}

// Whose group slots a member sees and books; the first trainer for unassigned members and visitors
export async function getMemberTrainerId(db: Q, memberId?: string): Promise<string | null> {
  if (memberId) {
    const [member] = await db
      .select({ trainerId: members.trainerId })
      .from(members)
      .where(eq(members.id, memberId))
      .limit(1);
    if (member?.trainerId) return member.trainerId;
  }
  return getDefaultTrainerId(db);
}

// Condition on `members`: own clients plus unassigned ones. Anyone else's client answers 404
export function visibleTo(trainerId: string) {
  return or(eq(members.trainerId, trainerId), isNull(members.trainerId))!;
}

// A disabled trainer answers 404 like a missing one
export async function enabledTrainer(db: Q, trainerId: string) {
  const [trainer] = await db
    .select({ id: admins.id })
    .from(admins)
    .where(and(eq(admins.id, trainerId), isNull(admins.disabledAt)))
    .limit(1);
  return trainer ?? null;
}

export async function requireVisibleMember(db: Q, trainerId: string, memberId: string) {
  const [member] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.id, memberId), visibleTo(trainerId)))
    .limit(1);
  if (!member) throw new NotFoundException('Member not found');
}

// Another trainer's slot answers 404. lock: FOR UPDATE on the slot row only, not its day
export async function requireOwnSlot(db: Q, trainerId: string, slotId: string, lock = false) {
  const query = db
    .select({ ...getTableColumns(trainingSlots), localDate: trainingDays.localDate })
    .from(trainingSlots)
    .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
    .where(eq(trainingSlots.id, slotId));
  const [slot] = await (lock ? query.for('update', { of: trainingSlots }).limit(1) : query.limit(1));
  if (!slot || slot.trainerId !== trainerId) throw new NotFoundException(apiError('SLOT_NOT_FOUND'));
  return slot;
}
