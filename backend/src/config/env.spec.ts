import { envProblems, validateEnv } from './env';

const MINIMAL = { DATABASE_URL: 'postgresql://user:pass@host/db', FRONTEND_URL: 'http://localhost:3000' };

const FULL = {
  ...MINIMAL,
  NODE_ENV: 'production',
  CRON_SECRET: 'a-long-random-secret',
  LIQPAY_PUBLIC_KEY: 'sandbox_pub',
  LIQPAY_PRIVATE_KEY: 'sandbox_priv',
  LIQPAY_SERVER_URL: 'https://api.example.com/payments/liqpay/callback',
  VAPID_PUBLIC_KEY: 'pub',
  VAPID_PRIVATE_KEY: 'priv',
  VAPID_SUBJECT: 'mailto:a@example.com',
  PORT: '3001',
};

describe('envProblems', () => {
  it('a local setup needs only the database and the frontend address', () => {
    expect(envProblems(MINIMAL)).toEqual([]);
  });

  it('a full production setup passes', () => {
    expect(envProblems(FULL)).toEqual([]);
  });

  it('missing or broken required URLs', () => {
    expect(envProblems({})).toEqual(['DATABASE_URL is missing', 'FRONTEND_URL is missing']);
    expect(envProblems({ ...MINIMAL, DATABASE_URL: 'not a url' })).toEqual(['DATABASE_URL is not a URL']);
  });

  it('CRON_SECRET is required in production only', () => {
    expect(envProblems({ ...FULL, CRON_SECRET: undefined })).toEqual([
      'CRON_SECRET is missing (required in production)',
    ]);
    expect(envProblems({ ...MINIMAL, NODE_ENV: 'development' })).toEqual([]);
  });

  it('LiqPay and push keys: all or none', () => {
    expect(envProblems({ ...FULL, LIQPAY_SERVER_URL: undefined })).toEqual([
      'LiqPay: LIQPAY_SERVER_URL missing (set all of LIQPAY_PUBLIC_KEY, LIQPAY_PRIVATE_KEY, LIQPAY_SERVER_URL, or none)',
    ]);
    expect(envProblems({ ...FULL, VAPID_SUBJECT: undefined, VAPID_PRIVATE_KEY: undefined })).toEqual([
      'Push: VAPID_PRIVATE_KEY, VAPID_SUBJECT missing (set all of VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, or none)',
    ]);
  });

  it('the LiqPay callback without /api', () => {
    expect(envProblems({ ...FULL, LIQPAY_SERVER_URL: 'https://api.example.com/api/payments/liqpay/callback' })).toEqual(
      ['LIQPAY_SERVER_URL must not start with /api (https://<backend>/payments/liqpay/callback)'],
    );
  });

  it('PORT is a positive whole number', () => {
    expect(envProblems({ ...MINIMAL, PORT: 'abc' })).toEqual(['PORT must be a positive whole number']);
    expect(envProblems({ ...MINIMAL, PORT: '0' })).toEqual(['PORT must be a positive whole number']);
  });
});

describe('validateEnv', () => {
  it('throws one error listing every problem', () => {
    expect(() => validateEnv({})).toThrow('Invalid environment:\n- DATABASE_URL is missing\n- FRONTEND_URL is missing');
  });

  it('passes a good setup', () => {
    expect(() => validateEnv(FULL)).not.toThrow();
  });
});
