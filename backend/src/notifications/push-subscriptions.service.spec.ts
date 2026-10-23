import { PushSubscriptionsService } from './push-subscriptions.service';
import { pushSubscriptions, adminPushSubscriptions } from '../database/schema';

// Records which table each insert / update hits; every query resolves to []
function makeDb() {
  const inserted: unknown[] = [];
  const updated: unknown[] = [];
  function link(): any {
    const chain: any = { then: (r: (v: unknown) => void) => r([]) };
    for (const m of ['values', 'onConflictDoUpdate', 'set', 'where']) chain[m] = jest.fn(() => chain);
    return chain;
  }
  const db: any = {
    insert: jest.fn((table: unknown) => {
      inserted.push(table);
      return link();
    }),
    update: jest.fn((table: unknown) => {
      updated.push(table);
      return link();
    }),
  };
  db.transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(db));
  return { db, inserted, updated };
}

describe('Push subscriptions — one browser, one role', () => {
  it('subscribing as a member switches off the same browser for trainer pushes', async () => {
    const { db, inserted, updated } = makeDb();
    await new PushSubscriptionsService({ db } as any).upsert('m1', 'https://push/phone', 'k', 'a');
    expect(inserted).toEqual([pushSubscriptions]);
    expect(updated).toEqual([adminPushSubscriptions]);
  });

  it('subscribing as a trainer switches off the same browser for member pushes', async () => {
    const { db, inserted, updated } = makeDb();
    await new PushSubscriptionsService({ db } as any).upsertAdmin('t1', 'https://push/phone', 'k', 'a');
    expect(inserted).toEqual([adminPushSubscriptions]);
    expect(updated).toEqual([pushSubscriptions]);
  });
});
