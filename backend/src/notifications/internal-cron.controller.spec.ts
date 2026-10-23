import { ForbiddenException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { InternalCronController } from './internal-cron.controller';

function makeController() {
  const paymentService = { expireStale: jest.fn().mockResolvedValue({ expired: 0 }) };
  const controller = new InternalCronController({} as any, {} as any, {} as any, {} as any, paymentService as any);
  return { controller, paymentService };
}

describe('InternalCronController — cron secret', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('rejects when CRON_SECRET is missing in production', async () => {
    delete process.env.CRON_SECRET;
    process.env.NODE_ENV = 'production';
    const { controller, paymentService } = makeController();
    await expect(controller.expirePayments(undefined as any)).rejects.toThrow(ForbiddenException);
    expect(paymentService.expireStale).not.toHaveBeenCalled();
  });

  it('allows manual runs without CRON_SECRET outside production', async () => {
    delete process.env.CRON_SECRET;
    process.env.NODE_ENV = 'development';
    const { controller } = makeController();
    await expect(controller.expirePayments(undefined as any)).resolves.toEqual({ expired: 0 });
  });

  it('rejects a wrong or missing Authorization header', async () => {
    process.env.CRON_SECRET = 'secret-1234567890';
    const { controller, paymentService } = makeController();
    await expect(controller.expirePayments('Bearer wrong')).rejects.toThrow(ForbiddenException);
    await expect(controller.expirePayments(undefined as any)).rejects.toThrow(ForbiddenException);
    expect(paymentService.expireStale).not.toHaveBeenCalled();
  });

  it('runs the job with the correct Bearer secret', async () => {
    process.env.CRON_SECRET = 'secret-1234567890';
    const { controller, paymentService } = makeController();
    await expect(controller.expirePayments('Bearer secret-1234567890')).resolves.toEqual({ expired: 0 });
    expect(paymentService.expireStale).toHaveBeenCalled();
  });
});

describe('InternalCronController — routes', () => {
  // Vercel Cron invokes with GET — a POST route answers 404 and the job silently never runs
  it.each(['bookingOpen', 'generateAnnouncement', 'autoConfirmAttendance', 'expirePayments'] as const)(
    '%s is a GET route',
    (handler) => {
      expect(Reflect.getMetadata(METHOD_METADATA, InternalCronController.prototype[handler])).toBe(RequestMethod.GET);
    },
  );
});
