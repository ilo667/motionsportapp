import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class SlotMembersDto {
  // Per-type count (personal 1, split 1-3) is checked in the service
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  memberIds: string[];
}
