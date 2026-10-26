import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class AddGuestDto {
  @IsUUID()
  slotId: string;

  // The guest's name only, as the trainer will see it
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name: string;
}
