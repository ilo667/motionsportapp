import { IsUUID } from 'class-validator';

export class AddClubCardDto {
  @IsUUID('all')
  priceItemId: string;
}
