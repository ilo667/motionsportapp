import { IsString } from 'class-validator';

export class UpsertPushSubscriptionDto {
  @IsString() endpoint: string;
  @IsString() p256dh: string;
  @IsString() auth: string;
}

export class DeletePushSubscriptionDto {
  @IsString() endpoint: string;
}