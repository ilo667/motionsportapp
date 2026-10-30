import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureApp } from './configure-app';

@Controller()
class PingController {
  @Get('ping')
  ping() {
    return { ok: true };
  }
}

// Real HTTP round trip; both entrypoints use configureApp, so this is what Vercel serves
describe('configureApp — security headers', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [PingController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());

  it('sends helmet headers and hides the framework', async () => {
    const res = await fetch(`${baseUrl}/ping`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});
