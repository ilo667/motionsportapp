import { NotFoundException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { BookingService } from './booking.service';
import { loadTrainerSchedule } from '../trainer-schedule/trainer-schedule.store';
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

jest.mock('../trainer-schedule/trainer-schedule.store', () => ({ loadTrainerSchedule: jest.fn() }));
const mockLoadSchedule = loadTrainerSchedule as jest.Mock;
beforeEach(() => mockLoadSchedule.mockResolvedValue({ bookingOpensAt: '14:00', autoCreate: true, times: [] }));

const KY_ZONE = 'Europe/Kyiv';

function kyivAt(hour: number, minute = 0): DateTime {
  return DateTime.fromObject({ year: 2026, month: 10, day: 20, hour, minute }, { zone: KY_ZONE });
}

// Proxy-based drizzle mock: each `await` on a read chain consumes the next result.
// Write chains resolve to `writeResult()` (what UPDATE … RETURNING gives back); `.set()` payloads go to `sets`
function makeDb(results: unknown[][] = [], writeResult: () => unknown = () => undefined) {
  let idx = 0;
  const next = () => results[idx++] ?? [];
  const sets: Record<string, unknown>[] = [];

  function readLink(): any {
    const then = (resolve: (v: unknown) => void) => resolve(next());
    const chain: any = { then };
    for (const m of ['from', 'innerJoin', 'where', 'for', 'orderBy', 'limit']) {
      chain[m] = jest.fn().mockImplementation(() => readLink());
    }
    return chain;
  }

  function writeLink(): any {
    const then = (resolve: (v: unknown) => void) => resolve(writeResult());
    const chain: any = { then };
    for (const m of ['where', 'values', 'onConflictDoNothing', 'returning']) {
      chain[m] = jest.fn().mockImplementation(() => writeLink());
    }
    chain.set = jest.fn().mockImplementation((v: Record<string, unknown>) => {
      sets.push(v);
      return writeLink();
    });
    return chain;
  }

  const db: any = {
    select: jest.fn().mockImplementation(() => readLink()),
    insert: jest.fn().mockImplementation(() => writeLink()),
    update: jest.fn().mockImplementation(() => writeLink()),
    transaction: jest.fn().mockImplementation(async (cb: (tx: any) => Promise<unknown>) => cb(db)),
  };
  return { db, sets };
}

const TODAY = '2026-10-20';

const validSlot = {
  id: 'slot-1',
  status: 'ACTIVE',
  trainingDayId: 'day-1',
  slotTime: '19:00',
  trainingType: 'групові',
  capacity: 8,
  bookedCount: 3,
  trainerId: 'trainer-1',
};

// getMemberTrainerId(): the member's trainer (members book only their trainer's group slots)
const MEMBER_TRAINER = [{ trainerId: 'trainer-1' }];

// book()/switchSlot() lock the member row first (one read inside the transaction)
const MEMBER = [{ id: 'member-1' }];

const validDay = {
  id: 'day-1',
  localDate: TODAY,
  status: 'SCHEDULED',
};

// groupPassLeft: group trainings the member's pass still holds for that day (booking needs one)
function makeService(db: any, now: DateTime, groupPassLeft = 1) {
  const mockClock = { now: () => now };
  const mockNotifications = { enqueueAndProcess: jest.fn().mockResolvedValue(undefined) };
  const mockVacancyAlerts = { unsubscribe: jest.fn().mockResolvedValue(undefined) };
  const mockEntitlements = { groupPassLeft: jest.fn().mockResolvedValue(groupPassLeft) };
  return new BookingService(
    { db } as any,
    mockNotifications as any,
    mockClock,
    mockVacancyAlerts as any,
    mockEntitlements as any,
  );
}

describe('BookingService — booking window', () => {
  it('throws before the trainer opens booking (14:00)', async () => {
    const { db } = makeDb([[validSlot], MEMBER_TRAINER, [validDay]]);
    const service = makeService(db, kyivAt(13, 59));
    await expect(service.book('member-1', 'slot-1')).rejects.toThrow('Booking is not open yet');
  });

  it('uses the opening time the trainer has now, not the one the training was created with', async () => {
    mockLoadSchedule.mockResolvedValue({ bookingOpensAt: '16:00', autoCreate: true, times: [] });
    const { db } = makeDb([[validSlot], MEMBER_TRAINER, [validDay]]);
    await expect(makeService(db, kyivAt(15)).book('member-1', 'slot-1')).rejects.toThrow('Booking is not open yet');
    expect(mockLoadSchedule).toHaveBeenCalledWith(db, 'trainer-1');
  });

  it('does not throw at exactly 14:00', async () => {
    // Window is open — error must come from inside the transaction (slot already locked), not window validation
    const lockedSlot = { ...validSlot, bookedCount: 8, capacity: 8 };
    const { db } = makeDb([[validSlot], MEMBER_TRAINER, [validDay], MEMBER, [lockedSlot]]);
    const service = makeService(db, kyivAt(14, 0));
    await expect(service.book('member-1', 'slot-1')).rejects.toThrow('Slot is full');
  });

  it('closes when the training starts (19:00), not at 21:00', async () => {
    const { db } = makeDb([[validSlot], MEMBER_TRAINER, [validDay]]);
    await expect(makeService(db, kyivAt(19, 0)).book('member-1', 'slot-1')).rejects.toThrow(
      'Booking window has closed',
    );
  });
});

describe('BookingService — freeze', () => {
  it('a member frozen on that day cannot book', async () => {
    (memberFrozenOn as jest.Mock).mockResolvedValue(true);
    const { db } = makeDb([[validSlot], MEMBER_TRAINER, [validDay]]);
    await expect(makeService(db, kyivAt(15)).book('member-1', 'slot-1')).rejects.toThrow('Membership frozen');
  });

  it('checked again under the member lock (a freeze approved at that moment)', async () => {
    (memberFrozenOn as jest.Mock).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { db } = makeDb([[validSlot], MEMBER_TRAINER, [validDay], MEMBER]);
    await expect(makeService(db, kyivAt(15)).book('member-1', 'slot-1')).rejects.toThrow('Membership frozen');
  });
});

describe('BookingService — slot validation', () => {
  const at15 = kyivAt(15);

  it('throws NotFoundException when slot does not exist', async () => {
    const { db } = makeDb([[]]);
    const service = makeService(db, at15);
    await expect(service.book('member-1', 'slot-x')).rejects.toThrow(NotFoundException);
  });

  it('throws ConflictException when slot is CANCELLED', async () => {
    const { db } = makeDb([[{ ...validSlot, status: 'CANCELLED' }]]);
    const service = makeService(db, at15);
    await expect(service.book('member-1', 'slot-1')).rejects.toThrow('Slot is cancelled');
  });

  it('throws when slot is full (checked inside transaction)', async () => {
    const fullSlot = { ...validSlot, bookedCount: 8, capacity: 8 };
    const { db } = makeDb([[validSlot], MEMBER_TRAINER, [validDay], MEMBER, [fullSlot]]);
    const service = makeService(db, at15);
    await expect(service.book('member-1', 'slot-1')).rejects.toThrow('Slot is full');
  });

  it("answers 404 for another trainer's group slot", async () => {
    const { db } = makeDb([[{ ...validSlot, trainerId: 'trainer-2' }], MEMBER_TRAINER]);
    const service = makeService(db, at15);
    await expect(service.book('member-1', 'slot-1')).rejects.toThrow(NotFoundException);
  });

  it('refuses an assigned slot (booked only through payment)', async () => {
    const { db } = makeDb([[{ ...validSlot, trainingType: 'персональні' }]]);
    const service = makeService(db, at15);
    await expect(service.book('member-1', 'slot-1')).rejects.toThrow('requires payment');
  });

  it('throws when member already has a group booking for that day', async () => {
    const available = { ...validSlot, bookedCount: 5 };
    const existingBooking = { id: 'booking-existing' };
    const { db } = makeDb([[validSlot], MEMBER_TRAINER, [validDay], MEMBER, [available], [existingBooking]]);
    const service = makeService(db, at15);
    await expect(service.book('member-1', 'slot-1')).rejects.toThrow('already have an active booking');
  });
});

describe('BookingService — group pass', () => {
  it('409 Group pass required without a pass that has trainings left, and nothing is booked', async () => {
    const { db } = makeDb([[validSlot], MEMBER_TRAINER, [validDay]]);
    await expect(makeService(db, kyivAt(15), 0).book('member-1', 'slot-1')).rejects.toThrow('Group pass required');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('with a pass that has trainings left it books as before', async () => {
    const { db } = makeDb([[validSlot], MEMBER_TRAINER, [validDay], MEMBER, [validSlot], []]);
    await expect(makeService(db, kyivAt(15), 1).book('member-1', 'slot-1')).resolves.toEqual({ ok: true });
    expect(db.insert).toHaveBeenCalled();
  });
});

describe('BookingService — cancel', () => {
  const booking = { id: 'booking-1', slotId: 'slot-p', trainingDayId: 'day-1', memberId: 'member-1', status: 'ACTIVE' };
  const assignedSlot = { bookedCount: 1, capacity: 1, slotTime: '21:30', trainingType: 'персональні' };

  it('throws NotFoundException when there is no active booking on that slot', async () => {
    const { db } = makeDb([[]]);
    const service = makeService(db, kyivAt(15));
    await expect(service.cancel('member-1', 'slot-1', 'reason')).rejects.toThrow(NotFoundException);
  });

  it('cancels an assigned booking after 21:00 while the training has not started', async () => {
    const { db } = makeDb([[booking], [validDay], [assignedSlot]]);
    const service = makeService(db, kyivAt(21, 10));
    await expect(service.cancel('member-1', 'slot-p', 'reason')).resolves.toEqual({ ok: true });
  });

  it('refuses to cancel an assigned booking once the training has started', async () => {
    const { db } = makeDb([[booking], [validDay], [assignedSlot]]);
    const service = makeService(db, kyivAt(21, 30));
    await expect(service.cancel('member-1', 'slot-p', 'reason')).rejects.toThrow('already started');
  });

  // A booked no-show loses the training, so a group booking can't be dropped once its training started
  it('a group booking can be cancelled until its training starts, not after', async () => {
    const groupSlot = { bookedCount: 3, capacity: 8, slotTime: '20:00', trainingType: 'групові' };
    const late = makeDb([[{ ...booking, slotId: 'slot-1' }], [validDay], [groupSlot]]);
    await expect(makeService(late.db, kyivAt(20, 0)).cancel('member-1', 'slot-1', 'reason')).rejects.toThrow(
      'Training has already started',
    );
    const inTime = makeDb([[{ ...booking, slotId: 'slot-1' }], [validDay], [groupSlot], [{ displayName: 'Оля' }]]);
    await expect(makeService(inTime.db, kyivAt(19, 59)).cancel('member-1', 'slot-1', 'reason')).resolves.toEqual({
      ok: true,
    });
  });
});

describe('BookingService — switch slot', () => {
  it('throws BadRequestException when switching to the same slot', async () => {
    const activeBooking = {
      id: 'booking-1',
      slotId: 'slot-1',
      trainingDayId: 'day-1',
      memberId: 'member-1',
      status: 'ACTIVE',
    };
    const { db } = makeDb([
      [{ trainingDayId: 'day-1', trainingType: 'групові', trainerId: 'trainer-1' }],
      MEMBER_TRAINER,
      [activeBooking],
    ]);
    const service = makeService(db, kyivAt(15));
    await expect(service.switchSlot('member-1', 'slot-1', 'reason')).rejects.toThrow('Already booked on this slot');
  });

  it('refuses to switch onto an assigned slot', async () => {
    const { db } = makeDb([[{ trainingDayId: 'day-1', trainingType: 'спліт' }]]);
    const service = makeService(db, kyivAt(15));
    await expect(service.switchSlot('member-1', 'slot-p', 'reason')).rejects.toThrow('Only group trainings');
  });

  it("answers 404 when switching onto another trainer's group slot", async () => {
    const { db } = makeDb([
      [{ trainingDayId: 'day-1', trainingType: 'групові', trainerId: 'trainer-2' }],
      MEMBER_TRAINER,
    ]);
    const service = makeService(db, kyivAt(15));
    await expect(service.switchSlot('member-1', 'slot-2', 'reason')).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when the member has no group booking that day (assigned ones do not count)', async () => {
    const { db } = makeDb([
      [{ trainingDayId: 'day-1', trainingType: 'групові', trainerId: 'trainer-1' }],
      MEMBER_TRAINER,
      [],
    ]);
    const service = makeService(db, kyivAt(15));
    await expect(service.switchSlot('member-1', 'slot-2', 'reason')).rejects.toThrow(NotFoundException);
  });
});
describe('BookingService — switch after a training started', () => {
  const current = { id: 'booking-1', slotId: 'slot-1', trainingDayId: 'day-1', memberId: 'member-1' };

  it('19:00 → 20:00 at 19:10: the own training already started', async () => {
    const target = { trainingDayId: 'day-1', trainingType: 'групові', slotTime: '20:00', trainerId: 'trainer-1' };
    const { db } = makeDb([
      [target],
      MEMBER_TRAINER,
      [current],
      [validDay],
      [{ bookedCount: 3, capacity: 8, slotTime: '19:00' }],
    ]);
    await expect(makeService(db, kyivAt(19, 10)).switchSlot('member-1', 'slot-2', 'r')).rejects.toThrow(
      'Training has already started',
    );
  });

  it('20:00 → 19:00 at 19:10: the target already started', async () => {
    const target = { trainingDayId: 'day-1', trainingType: 'групові', slotTime: '19:00', trainerId: 'trainer-1' };
    const { db } = makeDb([
      [target],
      MEMBER_TRAINER,
      [{ ...current, slotId: 'slot-2' }],
      [validDay],
      [{ bookedCount: 3, capacity: 8, slotTime: '20:00' }],
    ]);
    await expect(makeService(db, kyivAt(19, 10)).switchSlot('member-1', 'slot-1', 'r')).rejects.toThrow(
      'Booking window has closed',
    );
  });
});

describe('BookingService — trainer push with the reason', () => {
  it('sends MEMBER_CANCELLED with the reason to the trainer of that training', async () => {
    const booking = {
      id: 'booking-1',
      slotId: 'slot-1',
      trainingDayId: 'day-1',
      memberId: 'member-1',
      status: 'ACTIVE',
    };
    const groupSlot = {
      bookedCount: 3,
      capacity: 8,
      slotTime: '19:00',
      trainingType: 'групові',
      trainerId: 'trainer-1',
    };
    const { db } = makeDb([[booking], [validDay], [groupSlot], [{ displayName: 'Оля' }]]);
    const service = makeService(db, kyivAt(17));
    await service.cancel('member-1', 'slot-1', 'Захворіла');

    expect((service as any).notifications.enqueueAndProcess).toHaveBeenCalledWith(
      'MEMBER_CANCELLED',
      'member-cancelled:booking-1',
      {
        displayName: 'Оля',
        trainerId: 'trainer-1',
        slotTime: '19:00',
        localDate: TODAY,
        reason: 'Захворіла',
        switchedToTime: null,
      },
    );
  });

  it('records the target slot and sends the new time when a member moves 19:00 → 20:00', async () => {
    const current = { id: 'booking-1', slotId: 'slot-1', trainingDayId: 'day-1', memberId: 'member-1' };
    const target = { trainingDayId: 'day-1', trainingType: 'групові', slotTime: '20:00', trainerId: 'trainer-1' };
    const slot1 = { id: 'slot-1', status: 'ACTIVE', capacity: 8, bookedCount: 3 };
    const slot2 = { id: 'slot-2', status: 'ACTIVE', capacity: 8, bookedCount: 2 };
    const { db, sets } = makeDb(
      [
        [target],
        MEMBER_TRAINER,
        [current],
        [validDay],
        [{ bookedCount: 3, capacity: 8, slotTime: '19:00' }],
        MEMBER,
        [slot1],
        [slot2],
        [{ displayName: 'Іра' }],
      ],
      () => [{ id: 'booking-1' }], // the old booking's conditional UPDATE … RETURNING wins
    );
    const service = makeService(db, kyivAt(17));

    await service.switchSlot('member-1', 'slot-2', 'Не встигаю');

    expect(sets).toContainEqual(
      expect.objectContaining({ status: 'CANCELLED', switchedToSlotId: 'slot-2', cancellationReason: 'Не встигаю' }),
    );
    expect((service as any).notifications.enqueueAndProcess).toHaveBeenCalledWith(
      'MEMBER_CANCELLED',
      'member-cancelled:booking-1',
      expect.objectContaining({ displayName: 'Іра', slotTime: '19:00', switchedToTime: '20:00' }),
    );
    // waited for this slot → no vacancy push about the slot they now hold
    expect((service as any).vacancyAlerts.unsubscribe).toHaveBeenCalledWith('member-1', 'slot-2');
  });
});
