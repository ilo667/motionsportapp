import { IsUUID } from 'class-validator';

// Receives the disabled trainer's clients
export class DisableTrainerDto {
  @IsUUID('all')
  transferToId: string;
}
