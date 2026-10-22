import { IsString, MinLength, IsDateString, IsUUID } from 'class-validator';

export class CancelBookingDto {
  @IsUUID('all')
  slotId: string;

  @IsString()
  @MinLength(1)
  reason: string;

  @IsDateString()
  reasonAt: string;
}