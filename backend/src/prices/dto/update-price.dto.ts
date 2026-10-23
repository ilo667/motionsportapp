import { IsInt, Max, Min } from 'class-validator';

export const MAX_PRICE_UAH = 100_000;

export class UpdatePriceDto {
  @IsInt()
  @Min(1)
  @Max(MAX_PRICE_UAH)
  amountUah: number;

  // The amount the trainer saw on the page: the change applies only if nobody changed it meanwhile
  @IsInt()
  expectedAmountUah: number;
}
