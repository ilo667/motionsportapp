import { IsEnum, IsBoolean, IsOptional } from 'class-validator';

export type TrainingType = 'групові' | 'індивідуальні' | 'спліт';

export class UpsertTrainingDayDto {
  @IsEnum(['SCHEDULED', 'CANCELLED'])
  status: 'SCHEDULED' | 'CANCELLED';

  @IsEnum(['групові', 'індивідуальні', 'спліт'])
  @IsOptional()
  trainingType?: TrainingType;

  @IsBoolean()
  @IsOptional()
  isException?: boolean;
}