import { IsString, Length, Matches, MinLength, MaxLength } from 'class-validator';

// A new trainer signs up through an invite link
export class RegisterAdminDto {
  @IsString()
  @Length(64, 64)
  token: string;

  // Lowercase only, so «Olena» and «olena» can't become two trainers
  @IsString()
  @Matches(/^[a-z0-9._-]{3,32}$/, { message: 'Username: 3–32 of a-z, 0-9, ., _, -' })
  username: string;

  // No login rate limit: a long password is what protects a trainer account
  @IsString()
  @MinLength(10)
  @MaxLength(72)
  password: string;
}
