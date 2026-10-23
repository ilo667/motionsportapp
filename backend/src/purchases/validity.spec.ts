import { activateByFor, cardState, passState, passUsableOn, validUntilFor } from './validity';

describe('Validity — dates', () => {
  it('a month to activate, to the same date (or the month end)', () => {
    expect(activateByFor('2026-10-23')).toBe('2026-11-23');
    expect(activateByFor('2026-01-31')).toBe('2026-02-28');
  });

  it('valid for its months from activation; 0 months = that day only', () => {
    expect(validUntilFor('2026-10-23', 1)).toBe('2026-11-23');
    expect(validUntilFor('2026-10-23', 0)).toBe('2026-10-23');
  });
});

describe('Validity — which pass pays for a training on a date', () => {
  const waiting = { purchasedOn: '2026-10-23', activateBy: '2026-11-23', activatedOn: null, validUntil: null };
  const active = { ...waiting, activatedOn: '2026-11-01', validUntil: '2026-12-01' };

  it('not activated: from the purchase day to the last day to activate', () => {
    expect(passUsableOn(waiting, '2026-10-23')).toBe(true);
    expect(passUsableOn(waiting, '2026-11-23')).toBe(true);
    expect(passUsableOn(waiting, '2026-10-22')).toBe(false);
    expect(passUsableOn(waiting, '2026-11-24')).toBe(false);
  });

  it('activated: until its last day, never for a training before the purchase', () => {
    expect(passUsableOn(active, '2026-12-01')).toBe(true);
    expect(passUsableOn(active, '2026-12-02')).toBe(false);
    expect(passUsableOn(active, '2026-10-25')).toBe(true);
    expect(passUsableOn(active, '2026-10-22')).toBe(false);
  });
});

describe('Validity — states', () => {
  const card = { activateBy: '2026-11-23', validFrom: null, validUntil: null };

  it('a card waits for the trainer, then burns', () => {
    expect(cardState(card, '2026-11-23')).toBe('waiting');
    expect(cardState(card, '2026-11-24')).toBe('burned');
  });

  it('an activated card is active until its last day, then expired', () => {
    const on = { ...card, validFrom: '2026-11-01', validUntil: '2026-12-01' };
    expect(cardState(on, '2026-12-01')).toBe('active');
    expect(cardState(on, '2026-12-02')).toBe('expired');
  });

  it('a pass with nothing left is used, whatever its dates', () => {
    const pass = { purchasedOn: '2026-10-23', activateBy: '2026-11-23', activatedOn: null, validUntil: null };
    expect(passState({ ...pass, left: 0 }, '2026-10-24')).toBe('used');
    expect(passState({ ...pass, left: 3 }, '2026-10-24')).toBe('waiting');
    expect(passState({ ...pass, left: 3 }, '2026-11-24')).toBe('burned');
    expect(passState({ ...pass, activatedOn: '2026-11-01', validUntil: '2026-12-01', left: 3 }, '2026-12-02')).toBe(
      'expired',
    );
  });
});
