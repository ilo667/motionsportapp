import { IsUUID } from 'class-validator';

export class AssignCoachDto {
  @IsUUID('all')
  coachId: string;
}
