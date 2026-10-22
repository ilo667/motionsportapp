import { IsEnum, IsBoolean, IsOptional } from 'class-validator';

export class UpsertTrainingDayDto {
  @IsEnum(['SCHEDULED', 'CANCELLED'])
  status: 'SCHEDULED' | 'CANCELLED';

  @IsBoolean()
  @IsOptional()
  isException?: boolean;
}
