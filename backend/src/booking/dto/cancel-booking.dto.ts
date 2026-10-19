import { IsString, MinLength, IsDateString } from 'class-validator';

export class CancelBookingDto {
  @IsString()
  @MinLength(1)
  reason: string;

  @IsDateString()
  reasonAt: string;
}