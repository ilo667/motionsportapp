import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { DateTime } from 'luxon';
import { AuthService } from '../auth/auth.service';
import { hashToken } from '../auth/token';
import { RegisterAdminDto } from '../auth/dto/register-admin.dto';
import { SessionGuard } from '../auth/session.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { TrainerInvitesService } from './trainer-invites.service';
import { TrainerInvitesController } from './trainer-invites.controller';
import { KY_ZONE } from '../schedule/training-types';

const NOW = DateTime.fromISO('2026-10-24T12:00:00', { zone: KY_ZONE });
const TOKEN = 'a'.repeat(64);

// Drizzle chain mock: each awaited query takes the next result; set/values payloads are recorded
function makeDb(results: unknown[][]) {
  const queue = [...results];
  const sets: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];
  function link(): any {
    const chain: any = {
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
        Promise.resolve(queue.shift() ?? []).then(resolve, reject),
    };
    for (const m of ['from', 'where', 'orderBy', 'limit', 'returning', 'leftJoin', 'innerJoin']) {
      chain[m] = jest.fn(() => chain);
    }
    chain.set = jest.fn((v: Record<string, unknown>) => {
      sets.push(v);
      return chain;
    });
    chain.values = jest.fn((v: Record<string, unknown>) => {
      inserts.push(v);
      return chain;
    });
    return chain;
  }
  const db: any = { select: jest.fn(() => link()), update: jest.fn(() => link()), insert: jest.fn(() => link()) };
  db.transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(db));
  return { db, sets, inserts };
}

const clock = { now: () => NOW };
const auth = (db: any) => new AuthService({ db } as any, clock);
const invites = (db: any) => new TrainerInvitesService({ db } as any, clock);

describe('Trainer invites', () => {
  it('creates a 7-day invite and stores only the hash of the token', async () => {
    const { db, inserts } = makeDb([[{ id: 'inv-1' }]]);
    const result = await invites(db).create('trainer-1');

    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(result.expiresAt).toEqual(NOW.plus({ days: 7 }).toJSDate());
    expect(inserts).toEqual([
      { tokenHash: hashToken(result.token), createdByAdminId: 'trainer-1', expiresAt: result.expiresAt },
    ]);
  });

  it('answers 409 when revoking an invite that is used or already revoked', async () => {
    const { db } = makeDb([[]]);
    await expect(invites(db).revoke('inv-1')).rejects.toThrow(ConflictException);
  });

  it('is for signed-in trainers only', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, TrainerInvitesController)).toEqual([SessionGuard, AdminGuard]);
  });
});

describe('Trainer sign-up through an invite', () => {
  const dto = { token: TOKEN, username: 'olena', password: 'long-enough-pass' };

  it('creates the trainer, remembers who invited them and signs them in', async () => {
    const { db, sets, inserts } = makeDb([
      [{ id: 'inv-1', createdByAdminId: 'trainer-1' }], // invite taken
      [], // username free
      [{ id: 'trainer-2', username: 'olena' }], // admin inserted
      [], // invite marks who used it
      [], // session
    ]);
    const result = await auth(db).registerAdmin(dto);

    expect(result.username).toBe('olena');
    expect(result.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(sets).toEqual([{ usedAt: NOW.toJSDate() }, { usedByAdminId: 'trainer-2' }]);
    expect(inserts[0]).toMatchObject({ username: 'olena', invitedByAdminId: 'trainer-1' });
    expect(await bcrypt.compare(dto.password, inserts[0].passwordHash as string)).toBe(true);
    expect(inserts[1]).toMatchObject({ principalType: 'admin', principalId: 'trainer-2' });
  });

  it('refuses a used, revoked or expired link (the compare-and-set takes nothing)', async () => {
    const { db, inserts } = makeDb([[]]);
    await expect(auth(db).registerAdmin(dto)).rejects.toThrow(BadRequestException);
    expect(inserts).toEqual([]);
  });

  it('answers 409 for a taken username inside the transaction, so the invite is not spent', async () => {
    const { db, inserts } = makeDb([[{ id: 'inv-1', createdByAdminId: 'trainer-1' }], [{ id: 'trainer-x' }]]);
    await expect(auth(db).registerAdmin(dto)).rejects.toThrow(ConflictException);
    expect(db.transaction).toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it('accepts lowercase usernames of 3–32 characters and passwords of at least 10', async () => {
    const errors = async (v: object) =>
      (await validate(plainToInstance(RegisterAdminDto, { ...dto, ...v }))).map((e) => e.property);

    expect(await errors({})).toEqual([]);
    expect(await errors({ username: 'Olena' })).toEqual(['username']);
    expect(await errors({ username: 'ol' })).toEqual(['username']);
    expect(await errors({ username: 'olena kovalenko' })).toEqual(['username']);
    expect(await errors({ password: 'short' })).toEqual(['password']);
    expect(await errors({ token: 'abc' })).toEqual(['token']);
  });

  it('says whether a link is still valid', async () => {
    await expect(auth(makeDb([[{ id: 'inv-1' }]]).db).checkInvite(TOKEN)).resolves.toEqual({ valid: true });
    await expect(auth(makeDb([[]]).db).checkInvite(TOKEN)).resolves.toEqual({ valid: false });
  });
});

describe('Trainer password change', () => {
  it('changes the password and signs out the other sessions', async () => {
    const passwordHash = await bcrypt.hash('old-password', 4);
    const { db, sets } = makeDb([[{ passwordHash }], [], []]);
    await expect(
      auth(db).changeAdminPassword('trainer-1', 'session-1', {
        currentPassword: 'old-password',
        newPassword: 'new-long-password',
      }),
    ).resolves.toEqual({ ok: true });

    expect(await bcrypt.compare('new-long-password', sets[0].passwordHash as string)).toBe(true);
    expect(sets[1]).toEqual({ revokedAt: NOW.toJSDate() });
  });

  it('answers 401 for a wrong current password and changes nothing', async () => {
    const passwordHash = await bcrypt.hash('old-password', 4);
    const { db, sets } = makeDb([[{ passwordHash }]]);
    await expect(
      auth(db).changeAdminPassword('trainer-1', 'session-1', {
        currentPassword: 'wrong',
        newPassword: 'new-long-password',
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(sets).toEqual([]);
  });
});

describe('Trainer sign-in', () => {
  it('a disabled trainer gets the same «Invalid credentials» even with the right password', async () => {
    const passwordHash = await bcrypt.hash('long-enough-pass', 4);
    const { db, inserts } = makeDb([[{ id: 'trainer-2', username: 'olena', passwordHash, disabledAt: new Date() }]]);
    await expect(auth(db).loginAdmin({ username: 'olena', password: 'long-enough-pass' })).rejects.toThrow(
      new UnauthorizedException('Invalid credentials'),
    );
    expect(inserts).toEqual([]); // no session
  });
});
