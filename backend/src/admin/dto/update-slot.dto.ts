import { IsIn } from 'class-validator';

// Only cancelling: a cancelled training never comes back (a training added at that time is a new row, so the old one
// keeps its bookings, cancellations and late-cancellation fees)
export class UpdateSlotDto {
  @IsIn(['CANCELLED'])
  status: 'CANCELLED';
}
