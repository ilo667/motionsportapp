import { IsInt, Max, Min } from 'class-validator';

export const MAX_PRICE_UAH = 100_000;

export class UpdatePriceDto {
  @IsInt()
  @Min(1)
  @Max(MAX_PRICE_UAH)
  amountUah: number;

  // Compare-and-set: the amount the trainer saw
  @IsInt()
  expectedAmountUah: number;
}
