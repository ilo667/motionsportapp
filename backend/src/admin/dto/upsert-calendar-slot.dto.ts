import { IsEnum } from 'class-validator';

export class UpsertCalendarSlotDto {
  @IsEnum(['групові', 'індивідуальні', 'спліт'])
  trainingType: string;
}
