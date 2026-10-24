import { Controller, Get, Post, Delete, Param, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { TrainerInvitesService } from './trainer-invites.service';
import { SessionGuard, SessionUser } from '../auth/session.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';

@Controller('admin/trainer-invites')
@UseGuards(SessionGuard, AdminGuard)
export class TrainerInvitesController {
  constructor(private readonly invites: TrainerInvitesService) {}

  @Post()
  create(@CurrentUser() user: SessionUser) {
    return this.invites.create(user.id);
  }

  @Get()
  list() {
    return this.invites.listActive();
  }

  @Delete(':id')
  revoke(@Param('id', ParseUUIDPipe) id: string) {
    return this.invites.revoke(id);
  }
}
