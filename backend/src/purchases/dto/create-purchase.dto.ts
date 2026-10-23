import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';

export class CreatePurchaseDto {
  // A group pass alone; or a club card, a trainer service, or both (a service needs a card)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @IsUUID('all', { each: true })
  priceItemIds: string[];

  @IsIn(['LIQPAY', 'CASH'])
  method: 'LIQPAY' | 'CASH';

  // Group pass bought from «Записатися»: the training to book (cash: right away; LiqPay: once paid)
  @IsOptional()
  @IsUUID('all')
  slotId?: string;
}
