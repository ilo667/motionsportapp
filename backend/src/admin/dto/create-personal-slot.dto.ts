import { IsIn, Matches } from 'class-validator';
import { PERSONAL_TYPES } from '../../schedule/training-types';
import { SlotMembersDto } from './update-slot-members.dto';

export class CreatePersonalSlotDto extends SlotMembersDto {
  // Any time of day in 15-minute steps
  @Matches(/^([01]\d|2[0-3]):(00|15|30|45)$/)
  slotTime: string;

  @IsIn(PERSONAL_TYPES)
  trainingType: string;
}
