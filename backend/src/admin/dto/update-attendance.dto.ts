import { IsEnum } from 'class-validator';

export class UpdateAttendanceDto {
  @IsEnum(['PRESENT', 'ABSENT', 'UNMARKED'])
  status: 'PRESENT' | 'ABSENT' | 'UNMARKED';
}
