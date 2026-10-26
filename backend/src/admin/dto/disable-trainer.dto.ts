import { IsUUID } from 'class-validator';

// Whom the disabled trainer's clients go to
export class DisableTrainerDto {
  @IsUUID('all')
  transferToId: string;
}
