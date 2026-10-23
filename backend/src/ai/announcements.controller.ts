import { Controller, Get, Post, Put, Delete, Param, Body, UseGuards, HttpCode } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AnnouncementsService } from './announcements.service';

@Controller('admin/announcement-examples')
@UseGuards(SessionGuard, AdminGuard)
export class AnnouncementExamplesController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  list() {
    return this.announcements.listExamples();
  }

  @Post()
  add(@Body() body: { text: string }) {
    return this.announcements.addExample(body.text);
  }

  @Delete(':id')
  @HttpCode(200)
  remove(@Param('id') id: string) {
    return this.announcements.deleteExample(id);
  }
}

@Controller('admin/announcements')
@UseGuards(SessionGuard, AdminGuard)
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get(':date')
  get(@Param('date') date: string) {
    return this.announcements.getOrCreateForDate(date);
  }

  @Put(':date/topic')
  setTopic(@Param('date') date: string, @Body() body: { topic: string }) {
    return this.announcements.setTopic(date, body.topic);
  }

  @Post(':date/generate')
  @HttpCode(200)
  generate(@Param('date') date: string) {
    return this.announcements.generateAndSave(date);
  }

  @Put(':date/text')
  updateText(@Param('date') date: string, @Body() body: { text: string }) {
    return this.announcements.updateText(date, body.text);
  }

  @Post(':date/publish')
  @HttpCode(200)
  publish(@Param('date') date: string) {
    return this.announcements.publish(date);
  }

  @Post(':date/unpublish')
  @HttpCode(200)
  unpublish(@Param('date') date: string) {
    return this.announcements.unpublish(date);
  }
}
