import { IsUUID } from 'class-validator';

export class AssignTrainerDto {
  @IsUUID('all')
  trainerId: string;
}
