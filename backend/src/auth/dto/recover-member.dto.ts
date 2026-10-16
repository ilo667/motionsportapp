import { IsString, Matches } from 'class-validator';

export class RecoverMemberDto {
  @IsString()
  @Matches(/^GYM-\d{5}$/)
  memberCode: string;

  @IsString()
  recoveryCode: string;

  @IsString()
  @Matches(/^\d{6}$/)
  newPin: string;
}