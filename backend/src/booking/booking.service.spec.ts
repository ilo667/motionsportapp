import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { BookingService } from './booking.service';

const KY_ZONE = 'Europe/Kyiv';

function kyivAt(hour: number, minute = 0): DateTime {
  return DateTime.fromObject({ year: 2026, month: 10, day: 20, hour, minute }, { zone: KY_ZONE });
}

// Proxy-based drizzle mock: each `await` on a read chain consumes the next result.
// Write chains (insert/update) resolve to undefined without consuming results.
function makeDb(results: unknown[][] = []) {
  let idx = 0;
  const next = () => results[idx++] ?? [];

  function readLink(): any {
    const then = (resolve: (v: unknown) => void) => resolve(next());
    const chain: any = { then };
    for (const m of ['from', 'where', 'for', 'orderBy', 'limit']) {
      chain[m] = jest.fn().mockImplementation(() => readLink());
    }
    return chain;
  }

  function writeLink(): any {
    const then = (resolve: (v: void) => void) => resolve();
    const chain: any = { then };
    for (const m of ['set', 'where', 'values', 'onConflictDoNothing']) {
      chain[m] = jest.fn().mockImplementation(() => writeLink());
    }
    return chain;
  }

  const db: any = {
    select: jest.fn().mockImplementation(() => readLink()),
    insert: jest.fn().mockImplementation(() => writeLink()),
    update: jest.fn().mockImplementation(() => writeLink()),
    transaction: jest.fn().mockImplementation(async (cb: (tx: any) => Promise<unknown>) => cb(db)),
  };
  return { db };
}

const TODAY = '2026-10-20';

const validSlot = {
  id: 'slot-1',
  status: 'ACTIVE',
  trainingDayId: 'day-1',
  slotTime: '19:00',
  capacity: 8,
  bookedCount: 3,
};

const validDay = {
  id: 'day-1',
  localDate: TODAY,
  status: 'SCHEDULED',
};

function makeService(db: any, now: DateTime) {
  const mockDemoService = { getNow: jest.fn().mockResolvedValue(now), isDemoMode: jest.fn().mockReturnValue(false) };
  const mockNotifications = { enqueueAndProcess: jest.fn().mockResolvedValue(undefined) };
  return new BookingService(
    { db } as any,
    mockNotifications as any,
    mockDemoService as any,
  );
}

describe('BookingService — booking window', () => {
  it('throws before 14:00', async () => {
    const { db } = makeDb([[validSlot], [validDay]]);
    const service = makeService(db, kyivAt(13, 59));
    await expect(service.book('member-1', 'slot-1')).rejects.toThrow('Booking opens at 14:00');
  });

  it('throws after 21:00', async () => {
    const { db } = makeDb([[validSlot], [validDay]]);
    const service = makeService(db, kyivAt(21, 1));
    await expect(service.book('member-1', 'slot-1')).rejects.toThrow('Booking window has closed');
  });

  it('does not throw at exactly 14:00', async () => {
    // Window is open — error must come from inside the transaction (slot already locked), not window validation
    const lockedSlot = { ...validSlot, bookedCount: 8, capacity: 8 };
    const { db } = makeDb([[validSlot], [validDay], [lockedSlot]]);
    const service = makeService(db, kyivAt(14, 0));
    await expect(service.book('member-1', 'slot-1')).rejects.toThrow('Slot is full');
  });

  it('throws at exactly 21:00', async () => {
    const { db } = makeDb([[validSlot], [validDay]]);
    const service = makeService(db, kyivAt(21, 0));
    await expect(service.book('member-1', 'slot-1')).rejects.toThrow('Booking window has closed');
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
    const { db } = makeDb([[validSlot], [validDay], [fullSlot]]);
    const service = makeService(db, at15);
    await expect(service.book('member-1', 'slot-1')).rejects.toThrow('Slot is full');
  });

  it('throws when member already has a booking for that day', async () => {
    const available = { ...validSlot, bookedCount: 5 };
    const existingBooking = { id: 'booking-existing' };
    const { db } = makeDb([[validSlot], [validDay], [available], [existingBooking]]);
    const service = makeService(db, at15);
    await expect(service.book('member-1', 'slot-1')).rejects.toThrow('already have an active booking');
  });
});

describe('BookingService — cancel', () => {
  it('throws NotFoundException when there is no active booking', async () => {
    const { db } = makeDb([[]]);
    const service = makeService(db, kyivAt(15));
    await expect(service.cancelCurrent('member-1', 'reason', new Date())).rejects.toThrow(NotFoundException);
  });
});

describe('BookingService — switch slot', () => {
  it('throws BadRequestException when switching to the same slot', async () => {
    const activeBooking = { id: 'booking-1', slotId: 'slot-1', trainingDayId: 'day-1', memberId: 'member-1', status: 'ACTIVE' };
    const { db } = makeDb([[activeBooking]]);
    const service = makeService(db, kyivAt(15));
    await expect(service.switchSlot('member-1', 'slot-1', 'reason', new Date())).rejects.toThrow('Already booked on this slot');
  });
});