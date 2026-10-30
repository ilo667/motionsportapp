import { VacancyAlertsService } from './vacancy-alerts.service';

// One read: the slot's active alerts, each with the member's active booking there (or null)
function makeService(rows: unknown[]) {
  const chain: any = { then: (resolve: (v: unknown) => void) => resolve(rows) };
  for (const m of ['from', 'leftJoin', 'where']) chain[m] = jest.fn(() => chain);
  const db: any = { select: jest.fn(() => chain) };
  return new VacancyAlertsService({ db } as any);
}

describe('VacancyAlertsService — who gets «З’явилось місце»', () => {
  it('leaves out members already booked on the slot, however they got there', async () => {
    const svc = makeService([
      { memberId: 'm-waiting', bookingId: null },
      { memberId: 'm-booked', bookingId: 'b1' },
    ]);
    expect(await svc.findActiveSubscribersBySlot('slot-1')).toEqual(['m-waiting']);
  });

  it('leaves out the member who just cancelled', async () => {
    const svc = makeService([
      { memberId: 'm-waiting', bookingId: null },
      { memberId: 'm-cancelled', bookingId: null },
    ]);
    expect(await svc.findActiveSubscribersBySlot('slot-1', 'm-cancelled')).toEqual(['m-waiting']);
  });
});
