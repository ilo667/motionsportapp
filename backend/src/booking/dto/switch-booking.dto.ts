import { IsUUID, IsString, MinLength, IsDateString } from 'class-validator';

export class SwitchBookingDto {
  @IsUUID()
  newSlotId: string;

  @IsString()
  @MinLength(1)
  reason: string;

  @IsDateString()
  reasonAt: string;
}