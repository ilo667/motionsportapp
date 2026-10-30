// Environment variables are checked once, before Nest starts (main.ts and api/index.ts): a missing or broken one
// stops the start with a list of what is wrong, instead of failing later at the first query, payment or cron run.
// The full list with comments is in backend/.env.example

type Env = Record<string, string | undefined>;

const isUrl = (value: string) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

// A feature that needs several variables works with all of them or none (then it is off); a part is a mistake
function wholeGroup(env: Env, feature: string, names: string[]): string[] {
  const missing = names.filter((name) => !env[name]);
  if (missing.length === 0 || missing.length === names.length) return [];
  return [`${feature}: ${missing.join(', ')} missing (set all of ${names.join(', ')}, or none)`];
}

export function envProblems(env: Env): string[] {
  const problems: string[] = [];

  for (const name of ['DATABASE_URL', 'FRONTEND_URL']) {
    if (!env[name]) problems.push(`${name} is missing`);
    else if (!isUrl(env[name])) problems.push(`${name} is not a URL`);
  }

  // Vercel Cron and cron-job.org call /internal/cron/* with it; without it every run answers 403
  if (env.NODE_ENV === 'production' && !env.CRON_SECRET)
    problems.push('CRON_SECRET is missing (required in production)');

  problems.push(...wholeGroup(env, 'LiqPay', ['LIQPAY_PUBLIC_KEY', 'LIQPAY_PRIVATE_KEY', 'LIQPAY_SERVER_URL']));
  // LiqPay calls this URL itself: with /api it gets a 404 and payments hang in PENDING
  if (
    env.LIQPAY_SERVER_URL &&
    isUrl(env.LIQPAY_SERVER_URL) &&
    new URL(env.LIQPAY_SERVER_URL).pathname.startsWith('/api/')
  )
    problems.push('LIQPAY_SERVER_URL must not start with /api (https://<backend>/payments/liqpay/callback)');

  problems.push(...wholeGroup(env, 'Push', ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']));

  if (env.PORT !== undefined && !/^[1-9]\d*$/.test(env.PORT)) problems.push('PORT must be a positive whole number');

  return problems;
}

export function validateEnv(env: Env = process.env) {
  const problems = envProblems(env);
  if (problems.length) throw new Error(`Invalid environment:\n- ${problems.join('\n- ')}`);
}
