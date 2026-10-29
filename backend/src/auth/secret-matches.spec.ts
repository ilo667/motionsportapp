import * as bcrypt from 'bcryptjs';
import { secretMatches } from './auth.service';

jest.mock('bcryptjs', () => {
  const actual = jest.requireActual<typeof import('bcryptjs')>('bcryptjs');
  return { ...actual, compare: jest.fn((secret: string, hash: string) => actual.compare(secret, hash)) };
});

describe('secretMatches', () => {
  const hash = bcrypt.hashSync('123456', 4);

  beforeEach(() => jest.mocked(bcrypt.compare).mockClear());

  it('accepts the right secret', async () => {
    await expect(secretMatches('123456', hash)).resolves.toBe(true);
  });

  it('rejects a wrong secret', async () => {
    await expect(secretMatches('654321', hash)).resolves.toBe(false);
  });

  it('rejects when there is no account, after a cost-12 compare all the same', async () => {
    await expect(secretMatches('123456', undefined)).resolves.toBe(false);
    expect(bcrypt.compare).toHaveBeenCalledTimes(1);
    const usedHash = jest.mocked(bcrypt.compare).mock.calls[0][1];
    expect(bcrypt.getRounds(usedHash)).toBe(12);
  });
});
