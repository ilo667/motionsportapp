import { Controller, Get, Post, Param, UseGuards, HttpCode, ParseUUIDPipe } from '@nestjs/common';
import { FreezesService } from './freezes.service';
import { SessionGuard, SessionUser } from '../auth/session.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';

// Trainer side: freeze and unfreeze requests of own and unassigned clients
@Controller('admin')
@UseGuards(SessionGuard, AdminGuard)
export class AdminFreezesController {
  constructor(private readonly freezesService: FreezesService) {}

  @Get('freezes/pending')
  pending(@CurrentUser() user: SessionUser) {
    return this.freezesService.pending(user.id);
  }

  @Post('freezes/:id/approve')
  @HttpCode(200)
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.freezesService.approve(user.id, id);
  }

  @Post('freezes/:id/reject')
  @HttpCode(200)
  reject(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.freezesService.reject(user.id, id);
  }

  @Post('freezes/:id/unfreeze/approve')
  @HttpCode(200)
  approveUnfreeze(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.freezesService.approveUnfreeze(user.id, id);
  }

  @Post('freezes/:id/unfreeze/reject')
  @HttpCode(200)
  rejectUnfreeze(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.freezesService.rejectUnfreeze(user.id, id);
  }

  @Get('members/:memberId/freezes')
  memberHistory(@Param('memberId', ParseUUIDPipe) memberId: string, @CurrentUser() user: SessionUser) {
    return this.freezesService.memberHistory(user.id, memberId);
  }
}
