import { IsString, Matches } from 'class-validator';

export class LoginMemberDto {
  @IsString()
  @Matches(/^GYM-\d{5}$/)
  memberCode: string;

  @IsString()
  @Matches(/^\d{6}$/)
  pin: string;
}