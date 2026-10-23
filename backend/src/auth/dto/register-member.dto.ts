import { IsString, Length, Matches } from 'class-validator';

export class RegisterMemberDto {
  @IsString()
  @Length(2, 100)
  displayName: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'PIN must be exactly 6 digits' })
  pin: string;
}
