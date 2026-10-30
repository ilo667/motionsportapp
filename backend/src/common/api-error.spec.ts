import { ConflictException, Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureApp } from '../configure-app';
import { API_ERRORS, apiError, ruleError } from './api-error';

@Controller()
class FailingController {
  @Get('full')
  full() {
    throw new ConflictException(apiError('SLOT_FULL'));
  }

  @Get('target-full')
  targetFull() {
    throw new ConflictException(apiError('SLOT_FULL', 'Target slot is full'));
  }
}

describe('apiError', () => {
  it('keeps the English message as the exception message (logs, tests)', () => {
    expect(new ConflictException(apiError('CANCELLED_LATE')).message).toBe('Cancelled late');
  });

  it('every code has a message', () => {
    for (const message of Object.values(API_ERRORS)) expect(message).toMatch(/\w/);
  });
});

describe('ruleError', () => {
  it('a rule message from the list gets its code', () => {
    expect(ruleError(API_ERRORS.GROUP_GAP)).toEqual({ code: 'GROUP_GAP', message: API_ERRORS.GROUP_GAP });
  });

  it('another message has no code (the frontend shows its fallback)', () => {
    expect(ruleError('Unknown weekday')).toEqual({ message: 'Unknown weekday' });
  });
});

// The JSON body the frontend actually receives
describe('an error with a code over HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [FailingController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());

  it('answers 409 with { code, message }', async () => {
    const res = await fetch(`${baseUrl}/full`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'SLOT_FULL', message: 'Slot is full' });
  });

  it("a place's own wording keeps the same code", async () => {
    const res = await fetch(`${baseUrl}/target-full`);
    expect(await res.json()).toEqual({ code: 'SLOT_FULL', message: 'Target slot is full' });
  });
});
