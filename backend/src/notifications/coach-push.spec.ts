import { NotificationService } from './notification.service';
import { PushSubscriptionsController } from './push-subscriptions.controller';

const adminSub = { endpoint: 'https://push/admin', p256dh: 'k', auth: 'a' };

function makeNotifications() {
  const push = { send: jest.fn().mockResolvedValue('ok') };
  const subs = {
    findAllAdmin: jest.fn().mockResolvedValue([adminSub]),
    disableAdminByEndpoint: jest.fn(),
    findAll: jest.fn(),
  };
  const svc = new NotificationService({} as any, push as any, subs as any, {} as any);
  return { svc, push, subs };
}

describe('Coach push — member cancelled / moved', () => {
  it('sends the reason to the coach devices only', async () => {
    const { svc, push, subs } = makeNotifications();
    await (svc as any).sendMemberCancelled({
      displayName: 'Оля', slotTime: '19:00', localDate: '2026-10-22', reason: 'Захворіла', switchedToTime: null,
    });
    expect(subs.findAll).not.toHaveBeenCalled();
    expect(push.send).toHaveBeenCalledWith(adminSub, expect.objectContaining({
      title: 'Скасування 19:00, 22.10', body: 'Оля: Захворіла', url: '/admin',
    }));
  });

  it('names both times for a move', async () => {
    const { svc, push } = makeNotifications();
    await (svc as any).sendMemberCancelled({
      displayName: 'Іра', slotTime: '19:00', localDate: '2026-10-22', reason: 'Не встигаю', switchedToTime: '20:00',
    });
    expect(push.send).toHaveBeenCalledWith(adminSub, expect.objectContaining({ title: 'Перенесення 19:00 → 20:00, 22.10' }));
  });

  it('disables an expired coach subscription', async () => {
    const { svc, push, subs } = makeNotifications();
    push.send.mockResolvedValue('expired');
    await (svc as any).sendMemberCancelled({ displayName: 'Оля', slotTime: '19:00', localDate: '2026-10-22', reason: 'x', switchedToTime: null });
    expect(subs.disableAdminByEndpoint).toHaveBeenCalledWith(adminSub.endpoint);
  });
});

describe('Push subscriptions — admin vs member', () => {
  const dto = { endpoint: 'https://push/1', p256dh: 'k', auth: 'a' };
  const makeSvc = () => ({ upsert: jest.fn(), upsertAdmin: jest.fn(), remove: jest.fn(), removeAdmin: jest.fn() });

  it('stores the coach device in the admin table', async () => {
    const svc = makeSvc();
    await new PushSubscriptionsController(svc as any).subscribe(dto, { user: { type: 'admin', id: 'admin-1' } } as any);
    expect(svc.upsertAdmin).toHaveBeenCalledWith('admin-1', dto.endpoint, dto.p256dh, dto.auth);
    expect(svc.upsert).not.toHaveBeenCalled();
  });

  it('stores a member device in the members table', async () => {
    const svc = makeSvc();
    await new PushSubscriptionsController(svc as any).subscribe(dto, { user: { type: 'member', id: 'member-1' } } as any);
    expect(svc.upsert).toHaveBeenCalledWith('member-1', dto.endpoint, dto.p256dh, dto.auth);
    expect(svc.upsertAdmin).not.toHaveBeenCalled();
  });
});
