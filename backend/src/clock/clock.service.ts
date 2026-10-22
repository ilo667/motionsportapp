import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { KY_ZONE } from '../schedule/training-types';

// The single source of "now" (Kyiv time) for booking windows, payments, crons and the admin.
// A service rather than DateTime.now() so tests can pin the time
@Injectable()
export class ClockService {
  now(): DateTime {
    return DateTime.now().setZone(KY_ZONE);
  }
}
