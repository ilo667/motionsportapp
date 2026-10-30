import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class AddGuestDto {
  @IsUUID()
  slotId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name: string;
}
