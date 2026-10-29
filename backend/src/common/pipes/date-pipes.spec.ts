import { BadRequestException } from '@nestjs/common';
import { ParseDatePipe, ParseMonthPipe, ParseTimePipe } from './date-pipes';

describe('ParseDatePipe', () => {
  const pipe = new ParseDatePipe();

  it('passes a real day', () => {
    expect(pipe.transform('2026-10-29')).toBe('2026-10-29');
    expect(pipe.transform('2028-02-29')).toBe('2028-02-29');
  });

  it.each(['abc', '2026-02-30', '2027-02-29', '2026-13-01', '2026-1-05', '2026-10-29T10:00', '', undefined, 20261029])(
    'rejects %p with 400',
    (value) => {
      expect(() => pipe.transform(value)).toThrow(BadRequestException);
    },
  );

  it('optional: an absent value passes as undefined, a bad one still fails', () => {
    const optional = new ParseDatePipe({ optional: true });
    expect(optional.transform(undefined)).toBeUndefined();
    expect(() => optional.transform('2026-02-30')).toThrow(BadRequestException);
  });
});

describe('ParseMonthPipe', () => {
  const pipe = new ParseMonthPipe();

  it('passes a month', () => {
    expect(pipe.transform('2026-10')).toBe('2026-10');
  });

  it.each(['2026-13', '2026-1', '2026-10-01', 'oct', undefined])('rejects %p with 400', (value) => {
    expect(() => pipe.transform(value)).toThrow(BadRequestException);
  });
});

describe('ParseTimePipe', () => {
  const pipe = new ParseTimePipe();

  it('passes a time', () => {
    expect(pipe.transform('19:00')).toBe('19:00');
    expect(pipe.transform('06:15')).toBe('06:15');
  });

  it.each(['25:00', '19:60', '9:00', '19-00', '', undefined])('rejects %p with 400', (value) => {
    expect(() => pipe.transform(value)).toThrow(BadRequestException);
  });
});
