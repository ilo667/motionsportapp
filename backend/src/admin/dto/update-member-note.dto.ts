import { IsString, MaxLength } from 'class-validator';

export class UpdateMemberNoteDto {
  @IsString()
  @MaxLength(300)
  note: string;
}
