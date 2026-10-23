import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsUUID } from 'class-validator';

export class CreatePurchaseDto {
  // One trainer service, plus a club card when the member has no valid one
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @IsUUID('all', { each: true })
  priceItemIds: string[];

  @IsIn(['LIQPAY', 'CASH'])
  method: 'LIQPAY' | 'CASH';
}
