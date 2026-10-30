import { BadRequestException, PipeTransform } from '@nestjs/common';
import { DateTime } from 'luxon';

// A bad value ('2026-02-30', '25:00') answers 400 here instead of a Postgres error (500)
function strict(value: unknown, pattern: RegExp, format: string, message: string): string {
  if (typeof value === 'string' && pattern.test(value) && DateTime.fromFormat(value, format).isValid) return value;
  throw new BadRequestException(message);
}

// 'YYYY-MM-DD'. `optional` lets an absent query value through as undefined
export class ParseDatePipe implements PipeTransform<unknown, string | undefined> {
  constructor(private readonly options: { optional?: boolean } = {}) {}

  transform(value: unknown) {
    if (value === undefined && this.options.optional) return undefined;
    return strict(value, /^\d{4}-\d{2}-\d{2}$/, 'yyyy-MM-dd', 'Invalid date');
  }
}

export class ParseMonthPipe implements PipeTransform<unknown, string> {
  transform(value: unknown) {
    return strict(value, /^\d{4}-\d{2}$/, 'yyyy-MM', 'Invalid month');
  }
}

// 'HH:MM'; which times are allowed is up to the schedule rules
export class ParseTimePipe implements PipeTransform<unknown, string> {
  transform(value: unknown) {
    return strict(value, /^\d{2}:\d{2}$/, 'HH:mm', 'Invalid time');
  }
}
