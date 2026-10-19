import { IsUUID } from 'class-validator';

export class SwitchBookingDto {
  @IsUUID()
  newSlotId: string;
}