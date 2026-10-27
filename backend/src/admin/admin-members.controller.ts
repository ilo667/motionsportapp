import { Controller, Get, Patch, Body, Param, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { AdminMembersService } from './admin-members.service';
import { SessionGuard, SessionUser } from '../auth/session.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UpdateMemberNoteDto } from './dto/update-member-note.dto';
import { AssignTrainerDto } from './dto/assign-trainer.dto';

@Controller('admin')
@UseGuards(SessionGuard, AdminGuard)
export class AdminMembersController {
  constructor(private readonly adminMembersService: AdminMembersService) {}

  @Get('members')
  getMembers(@CurrentUser() user: SessionUser) {
    return this.adminMembersService.getMembers(user.id);
  }

  @Get('members/:memberId')
  getMember(@Param('memberId', ParseUUIDPipe) memberId: string, @CurrentUser() user: SessionUser) {
    return this.adminMembersService.getMember(user.id, memberId);
  }

  @Get('members/:memberId/visits')
  getMemberVisits(@Param('memberId', ParseUUIDPipe) memberId: string, @CurrentUser() user: SessionUser) {
    return this.adminMembersService.getMemberVisits(user.id, memberId);
  }

  @Patch('members/:memberId/trainer')
  assignTrainer(
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: AssignTrainerDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.adminMembersService.assignTrainer(user.id, memberId, dto.trainerId);
  }

  @Get('members/:memberId/cancellations')
  getMemberCancellations(@Param('memberId', ParseUUIDPipe) memberId: string, @CurrentUser() user: SessionUser) {
    return this.adminMembersService.getMemberCancellations(user.id, memberId);
  }

  @Patch('members/:memberId/note')
  updateMemberNote(
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: UpdateMemberNoteDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.adminMembersService.updateMemberNote(user.id, memberId, dto);
  }
}
