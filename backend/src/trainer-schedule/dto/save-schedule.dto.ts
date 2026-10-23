import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, Matches, Max, Min, ValidateNested } from 'class-validator';

const HH_MM = /^\d{2}:\d{2}$/;

class ScheduleTimeDto {
  @IsInt()
  @Min(1)
  @Max(7)
  weekday: number;

  @Matches(HH_MM)
  slotTime: string;
}

// «Мій розклад» as a whole; the rules (06:00–21:00, an hour apart, opening first) are checked by the service
export class SaveScheduleDto {
  @Matches(HH_MM)
  bookingOpensAt: string;

  @IsBoolean()
  autoCreate: boolean;

  @IsArray()
  @ArrayMaxSize(7 * 16)
  @ValidateNested({ each: true })
  @Type(() => ScheduleTimeDto)
  times: ScheduleTimeDto[];
}
