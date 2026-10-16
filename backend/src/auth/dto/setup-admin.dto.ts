import { IsString, Length, MinLength } from 'class-validator';

export class SetupAdminDto {
  @IsString()
  @Length(3, 50)
  username: string;

  @IsString()
  @MinLength(8)
  password: string;
}