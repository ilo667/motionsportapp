import { IsString, MaxLength } from 'class-validator';

// An announcement or a style example: the AI writes up to 150 characters, so 500 leaves room for the trainer's edits
export class AnnouncementTextDto {
  @IsString()
  @MaxLength(500)
  text: string;
}

// The day's topic, overriding the weekly programme in the AI prompt
export class AnnouncementTopicDto {
  @IsString()
  @MaxLength(100)
  topic: string;
}
