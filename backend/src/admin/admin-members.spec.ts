import { DateTime } from 'luxon';
import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminMembersService } from './admin-members.service';
import { AdminScheduleController } from './admin-schedule.controller';
import { AdminGuard } from '../common/guards/admin.guard';
import { UpdateMemberNoteDto } from './dto/update-member-note.dto';
import { loadFreezes, memberFrozenOn, openFreeze } from '../freezes/freeze.store';

// No member is frozen unless a test says so
jest.mock('../freezes/freeze.store', () => ({
  loadFreezes: jest.fn(),
  memberFrozenOn: jest.fn(),
  openFreeze: jest.fn(),
}));
beforeEach(() => {
  (loadFreezes as jest.Mock).mockResolvedValue([]);
  (memberFrozenOn as jest.Mock).mockResolvedValue(false);
  (openFreeze as jest.Mock).mockResolvedValue(null);
});

// Minimal drizzle chain mock: every await resolves to `result`; `.set()` payloads are recorded
function makeDb(result: unknown[]) {
  const sets: Record<string, unknown>[] = [];
  function link(): any {
    const chain: any = { then: (r: (v: unknown) => void) => r(result) };
    for (const m of ['from', 'where', 'orderBy', 'limit', 'returning', 'innerJoin', 'leftJoin'])
      chain[m] = jest.fn(() => link());
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
  const clock = { now: () => DateTime.fromISO('2026-10-26T12:00:00', { zone: 'Europe/Kyiv' }) };
  return new AdminMembersService({ db } as any, clock, entitlements as any);
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
      { ...rows[0], clubCard: null, packagesLeft: [], frozenUntil: null },
    ]);
  });

  it("shows each client's club card and trainings left", async () => {
    const { db } = makeDb([{ id: 'm1', displayName: 'Катя' }]);
    const summaries = new Map([
      [
        'm1',
        {
          clubCard: { state: 'active', until: '2026-12-15' },
          packagesLeft: [{ trainingType: 'personal', left: 5 }],
        },
      ],
    ]);
    await expect(makeService(db, summaries).getMembers('trainer-1')).resolves.toEqual([
      {
        id: 'm1',
        displayName: 'Катя',
        clubCard: { state: 'active', until: '2026-12-15' },
        packagesLeft: [{ trainingType: 'personal', left: 5 }],
        frozenUntil: null,
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

describe('Admin members — freeze', () => {
  it('a client frozen today shows the last frozen day', async () => {
    (loadFreezes as jest.Mock).mockResolvedValue([
      { id: 'f1', memberId: 'm1', status: 'ACTIVE', startedOn: '2026-10-20', endsOn: '2026-11-19' },
    ]);
    const { db } = makeDb([{ id: 'm1', displayName: 'Катя' }]);
    const [row] = await makeService(db).getMembers('trainer-1');
    expect(row.frozenUntil).toBe('2026-11-18');
  });
});

describe('Admin members — client page', () => {
  it('one client, the same row as in the list', async () => {
    const { db } = makeDb([{ id: 'm1', displayName: 'Катя' }]);
    await expect(makeService(db).getMember('trainer-1', 'm1')).resolves.toEqual({
      id: 'm1',
      displayName: 'Катя',
      clubCard: null,
      packagesLeft: [],
      frozenUntil: null,
    });
  });

  it("another trainer's client (or a missing one) answers 404", async () => {
    const { db } = makeDb([]);
    await expect(makeService(db).getMember('trainer-1', 'm9')).rejects.toThrow(NotFoundException);
  });

  it('visits: past and today trainings with the mark, newest first; unmarked ones are UNMARKED', async () => {
    const rows = [
      { bookingId: 'b2', localDate: '2026-10-22', slotTime: '19:00', trainingType: 'group', status: null },
      { bookingId: 'b1', localDate: '2026-10-20', slotTime: '18:00', trainingType: 'personal', status: 'ABSENT' },
    ];
    // the visibility check, then the visits
    const { db } = makeDb(rows);
    const visits = await makeService(db).getMemberVisits('trainer-1', 'm1');
    expect(visits).toEqual([
      { bookingId: 'b2', localDate: '2026-10-22', slotTime: '19:00', trainingType: 'group', attendance: 'UNMARKED' },
      {
        bookingId: 'b1',
        localDate: '2026-10-20',
        slotTime: '18:00',
        trainingType: 'personal',
        attendance: 'ABSENT',
      },
    ]);
  });

  it("visits of another trainer's client answer 404", async () => {
    const { db } = makeDb([]);
    await expect(makeService(db).getMemberVisits('trainer-1', 'm9')).rejects.toThrow(NotFoundException);
  });
});
