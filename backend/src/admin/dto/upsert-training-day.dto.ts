import { IsEnum, IsBoolean, IsOptional } from 'class-validator';

export type TrainingType = 'групові' | 'персональні' | 'спліт';

export class UpsertTrainingDayDto {
  @IsEnum(['SCHEDULED', 'CANCELLED'])
  status: 'SCHEDULED' | 'CANCELLED';

  @IsEnum(['групові', 'персональні', 'спліт'])
  @IsOptional()
  trainingType?: TrainingType;

  @IsBoolean()
  @IsOptional()
  isException?: boolean;
}