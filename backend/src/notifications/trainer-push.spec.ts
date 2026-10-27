import { NotificationService } from './notification.service';
import { PushSubscriptionsController } from './push-subscriptions.controller';

const adminSub = { endpoint: 'https://push/admin', p256dh: 'k', auth: 'a' };

function makeNotifications() {
  const push = { send: jest.fn().mockResolvedValue('ok') };
  const subs = {
    findAllAdmin: jest.fn().mockResolvedValue([adminSub]),
    findAdminByAdminId: jest.fn().mockResolvedValue([adminSub]),
    disableAdminByEndpoint: jest.fn(),
    findAll: jest.fn().mockResolvedValue([]),
    findForTrainers: jest.fn().mockResolvedValue([]),
  };
  const svc = new NotificationService({} as any, push as any, subs as any, {} as any);
  return { svc, push, subs };
}

// A failed push never fails the request that sent it: a member's cancel, a cash request, a freeze, «Відхилити»
describe('Push — a failure is logged, never thrown', () => {
  it('the event row cannot be written (the database is down)', async () => {
    const db = {
      insert: () => ({
        values: () => ({ onConflictDoNothing: () => ({ returning: () => Promise.reject(new Error('db down')) }) }),
      }),
    };
    const svc = new NotificationService({ db } as any, {} as any, {} as any, {} as any);
    jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);
    await expect(svc.enqueueAndProcess('CASH_REQUESTED', 'cash-requested:p1', {})).resolves.toBeUndefined();
    expect((svc as any).logger.error).toHaveBeenCalledWith('Push cash-requested:p1 failed', expect.any(Error));
  });
});

describe('Trainer push — member cancelled / moved', () => {
  it('sends the reason to the trainer devices only', async () => {
    const { svc, push, subs } = makeNotifications();
    await (svc as any).sendMemberCancelled({
      displayName: 'Оля',
      slotTime: '19:00',
      localDate: '2026-10-22',
      reason: 'Захворіла',
      switchedToTime: null,
    });
    expect(subs.findAll).not.toHaveBeenCalled();
    expect(push.send).toHaveBeenCalledWith(
      adminSub,
      expect.objectContaining({
        title: 'Скасування 19:00, 22.10',
        body: 'Оля: Захворіла',
        url: '/admin',
      }),
    );
  });

  it('names both times for a move', async () => {
    const { svc, push } = makeNotifications();
    await (svc as any).sendMemberCancelled({
      displayName: 'Іра',
      slotTime: '19:00',
      localDate: '2026-10-22',
      reason: 'Не встигаю',
      switchedToTime: '20:00',
    });
    expect(push.send).toHaveBeenCalledWith(
      adminSub,
      expect.objectContaining({ title: 'Перенесення 19:00 → 20:00, 22.10' }),
    );
  });

  it("goes only to the member's trainer when the member has one", async () => {
    const { svc, subs } = makeNotifications();
    await (svc as any).sendMemberCancelled({
      displayName: 'Оля',
      slotTime: '19:00',
      localDate: '2026-10-22',
      reason: 'x',
      switchedToTime: null,
      trainerId: 'trainer-2',
    });
    expect(subs.findAdminByAdminId).toHaveBeenCalledWith('trainer-2');
    expect(subs.findAllAdmin).not.toHaveBeenCalled();
  });

  it('goes to every trainer for an unassigned member', async () => {
    const { svc, subs } = makeNotifications();
    await (svc as any).sendMemberCancelled({
      displayName: 'Оля',
      slotTime: '19:00',
      localDate: '2026-10-22',
      reason: 'x',
      switchedToTime: null,
      trainerId: null,
    });
    expect(subs.findAllAdmin).toHaveBeenCalled();
    expect(subs.findAdminByAdminId).not.toHaveBeenCalled();
  });

  it('disables an expired trainer subscription', async () => {
    const { svc, push, subs } = makeNotifications();
    push.send.mockResolvedValue('expired');
    await (svc as any).sendMemberCancelled({
      displayName: 'Оля',
      slotTime: '19:00',
      localDate: '2026-10-22',
      reason: 'x',
      switchedToTime: null,
    });
    expect(subs.disableAdminByEndpoint).toHaveBeenCalledWith(adminSub.endpoint);
  });
});

describe('Booking-open push', () => {
  it('goes only to clients of trainers with group trainings today (and unassigned ones when asked)', async () => {
    const { svc, subs } = makeNotifications();
    await (svc as any).sendOpening({ localDate: '2026-10-26', trainerIds: ['trainer-1'], includeUnassigned: true });
    expect(subs.findForTrainers).toHaveBeenCalledWith(['trainer-1'], true);
    expect(subs.findAll).not.toHaveBeenCalled();
  });
});

describe('Push subscriptions — admin vs member', () => {
  const dto = { endpoint: 'https://push/1', p256dh: 'k', auth: 'a' };
  const makeSvc = () => ({ upsert: jest.fn(), upsertAdmin: jest.fn(), remove: jest.fn(), removeAdmin: jest.fn() });

  it('stores the trainer device in the admin table', async () => {
    const svc = makeSvc();
    await new PushSubscriptionsController(svc as any).subscribe(dto, { user: { type: 'admin', id: 'admin-1' } });
    expect(svc.upsertAdmin).toHaveBeenCalledWith('admin-1', dto.endpoint, dto.p256dh, dto.auth);
    expect(svc.upsert).not.toHaveBeenCalled();
  });

  it('stores a member device in the members table', async () => {
    const svc = makeSvc();
    await new PushSubscriptionsController(svc as any).subscribe(dto, { user: { type: 'member', id: 'member-1' } });
    expect(svc.upsert).toHaveBeenCalledWith('member-1', dto.endpoint, dto.p256dh, dto.auth);
    expect(svc.upsertAdmin).not.toHaveBeenCalled();
  });
});
