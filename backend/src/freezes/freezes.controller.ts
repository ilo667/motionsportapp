import { Controller, Get, Post, UseGuards, HttpCode } from '@nestjs/common';
import { FreezesService } from './freezes.service';
import { SessionGuard, SessionUser } from '../auth/session.guard';
import { MemberGuard } from '../common/guards/member.guard';
import { CurrentUser } from '../auth/current-user.decorator';

// A member's own freeze: its state, ask to freeze, take the request back, ask to unfreeze
@Controller('freezes')
@UseGuards(SessionGuard, MemberGuard)
export class FreezesController {
  constructor(private readonly freezesService: FreezesService) {}

  @Get()
  getMine(@CurrentUser() user: SessionUser) {
    return this.freezesService.forMember(user.id);
  }

  @Post()
  @HttpCode(200)
  request(@CurrentUser() user: SessionUser) {
    return this.freezesService.request(user.id);
  }

  @Post('cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: SessionUser) {
    return this.freezesService.cancelRequest(user.id);
  }

  @Post('unfreeze')
  @HttpCode(200)
  unfreeze(@CurrentUser() user: SessionUser) {
    return this.freezesService.requestUnfreeze(user.id);
  }
}
