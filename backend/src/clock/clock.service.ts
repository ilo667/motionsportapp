import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { KY_ZONE } from '../schedule/training-types';

// The only source of "now" (Kyiv); injectable so tests can pin the time
@Injectable()
export class ClockService {
  now(): DateTime {
    return DateTime.now().setZone(KY_ZONE);
  }
}
