import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminScheduleService } from './admin-schedule.service';
import { AdminScheduleController } from './admin-schedule.controller';
import { AdminGuard } from '../common/guards/admin.guard';
import { UpdateMemberNoteDto } from './dto/update-member-note.dto';

// Minimal drizzle chain mock: every await resolves to `result`; `.set()` payloads are recorded
function makeDb(result: unknown[]) {
  const sets: Record<string, unknown>[] = [];
  function link(): any {
    const chain: any = { then: (r: (v: unknown) => void) => r(result) };
    for (const m of ['from', 'where', 'orderBy', 'limit', 'returning']) chain[m] = jest.fn(() => link());
    chain.set = jest.fn((v: Record<string, unknown>) => {
      sets.push(v);
      return link();
    });
    return chain;
  }
  const db: any = { select: jest.fn(() => link()), update: jest.fn(() => link()) };
  return { db, sets };
}

function makeService(db: any, summaries = new Map()) {
  const entitlements = { summaries: jest.fn().mockResolvedValue(summaries) };
  return new AdminScheduleService({ db } as any, {} as any, {} as any, entitlements as any);
}

describe('Admin members — trainer note', () => {
  it('lists members with their trainer note', async () => {
    const rows = [
      {
        id: 'm1',
        memberCode: 'GYM-11111',
        displayName: 'Катя',
        trainerNote: 'ходить через раз',
        createdAt: new Date(),
      },
    ];
    const { db } = makeDb(rows);
    await expect(makeService(db).getMembers('trainer-1')).resolves.toEqual([
      { ...rows[0], clubCardUntil: null, packagesLeft: [] },
    ]);
  });

  it("shows each client's club card and trainings left", async () => {
    const { db } = makeDb([{ id: 'm1', displayName: 'Катя' }]);
    const summaries = new Map([
      ['m1', { clubCardUntil: '2026-12-15', packagesLeft: [{ trainingType: 'персональні', left: 5 }] }],
    ]);
    await expect(makeService(db, summaries).getMembers('trainer-1')).resolves.toEqual([
      {
        id: 'm1',
        displayName: 'Катя',
        clubCardUntil: '2026-12-15',
        packagesLeft: [{ trainingType: 'персональні', left: 5 }],
      },
    ]);
  });

  it('saves a trimmed note', async () => {
    const { db, sets } = makeDb([{ id: 'm1', trainerNote: 'це Катюха' }]);
    await makeService(db).updateMemberNote('trainer-1', 'm1', { note: '  це Катюха  ' });
    expect(sets).toEqual([{ trainerNote: 'це Катюха' }]);
  });

  it('clears the note when empty text is sent', async () => {
    const { db, sets } = makeDb([{ id: 'm1', trainerNote: null }]);
    await makeService(db).updateMemberNote('trainer-1', 'm1', { note: '   ' });
    expect(sets).toEqual([{ trainerNote: null }]);
  });

  it('throws NotFoundException for an unknown member', async () => {
    const { db } = makeDb([]);
    await expect(makeService(db).updateMemberNote('trainer-1', 'missing', { note: 'x' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('rejects notes longer than 300 characters', async () => {
    const errors = await validate(plainToInstance(UpdateMemberNoteDto, { note: 'a'.repeat(301) }));
    expect(errors).toHaveLength(1);
    expect(await validate(plainToInstance(UpdateMemberNoteDto, { note: 'a'.repeat(300) }))).toHaveLength(0);
  });

  it('member endpoints are admin-only (AdminGuard on the controller)', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminScheduleController) as unknown[];
    expect(guards).toContain(AdminGuard);
  });
});
