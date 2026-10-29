import { Controller, Get, Post, Put, Delete, Param, Body, UseGuards, HttpCode, ParseUUIDPipe } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AnnouncementsService } from './announcements.service';
import { AnnouncementTextDto, AnnouncementTopicDto } from './dto/announcement.dto';
import { ParseDatePipe } from '../common/pipes/date-pipes';

@Controller('admin/announcement-examples')
@UseGuards(SessionGuard, AdminGuard)
export class AnnouncementExamplesController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  list() {
    return this.announcements.listExamples();
  }

  @Post()
  add(@Body() body: AnnouncementTextDto) {
    return this.announcements.addExample(body.text);
  }

  @Delete(':id')
  @HttpCode(200)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.announcements.deleteExample(id);
  }
}

@Controller('admin/announcements')
@UseGuards(SessionGuard, AdminGuard)
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get(':date')
  get(@Param('date', ParseDatePipe) date: string) {
    return this.announcements.getOrCreateForDate(date);
  }

  @Put(':date/topic')
  setTopic(@Param('date', ParseDatePipe) date: string, @Body() body: AnnouncementTopicDto) {
    return this.announcements.setTopic(date, body.topic);
  }

  @Post(':date/generate')
  @HttpCode(200)
  generate(@Param('date', ParseDatePipe) date: string) {
    return this.announcements.generateAndSave(date);
  }

  @Put(':date/text')
  updateText(@Param('date', ParseDatePipe) date: string, @Body() body: AnnouncementTextDto) {
    return this.announcements.updateText(date, body.text);
  }

  @Post(':date/publish')
  @HttpCode(200)
  publish(@Param('date', ParseDatePipe) date: string) {
    return this.announcements.publish(date);
  }

  @Post(':date/unpublish')
  @HttpCode(200)
  unpublish(@Param('date', ParseDatePipe) date: string) {
    return this.announcements.unpublish(date);
  }
}
