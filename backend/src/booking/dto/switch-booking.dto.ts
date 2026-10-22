import { IsUUID, IsString, MinLength } from 'class-validator';

export class SwitchBookingDto {
  @IsUUID()
  newSlotId: string;

  @IsString()
  @MinLength(1)
  reason: string;
}