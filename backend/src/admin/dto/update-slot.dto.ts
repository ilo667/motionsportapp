import { IsEnum } from 'class-validator';

export class UpdateSlotDto {
  @IsEnum(['ACTIVE', 'CANCELLED'])
  status: 'ACTIVE' | 'CANCELLED';
}
