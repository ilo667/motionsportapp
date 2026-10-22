import { IsEnum } from 'class-validator';

export class UpsertTrainingDayDto {
  @IsEnum(['SCHEDULED', 'CANCELLED'])
  status: 'SCHEDULED' | 'CANCELLED';
}
