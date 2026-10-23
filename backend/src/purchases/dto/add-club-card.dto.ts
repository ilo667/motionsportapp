import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class AddClubCardDto {
  @IsUUID('all')
  priceItemId: string;

  // «Додати й активувати з сьогодні»
  @IsOptional()
  @IsBoolean()
  activate?: boolean;
}
