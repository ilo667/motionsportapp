import { IsEnum, IsBoolean, IsOptional, Matches } from 'class-validator';

export class UpsertTrainingDayDto {
  @IsEnum(['SCHEDULED', 'CANCELLED'])
  status: 'SCHEDULED' | 'CANCELLED';

  @IsBoolean()
  @IsOptional()
  isException?: boolean;
}