import { IsIn } from 'class-validator';

// Cancel only: never revived. Re-adding makes a new row, so the old one keeps its bookings and fees
export class UpdateSlotDto {
  @IsIn(['CANCELLED'])
  status: 'CANCELLED';
}
