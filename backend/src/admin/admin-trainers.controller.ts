import { Controller, Get, Post, Body, Param, UseGuards, HttpCode, HttpStatus, ParseUUIDPipe } from '@nestjs/common';
import { AdminTrainersService } from './admin-trainers.service';
import { SessionGuard, SessionUser } from '../auth/session.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { DisableTrainerDto } from './dto/disable-trainer.dto';

@Controller('admin')
@UseGuards(SessionGuard, AdminGuard)
export class AdminTrainersController {
  constructor(private readonly adminTrainersService: AdminTrainersService) {}

  @Get('trainers')
  getTrainers() {
    return this.adminTrainersService.getTrainers();
  }

  @Post('trainers/:trainerId/disable')
  @HttpCode(HttpStatus.OK)
  disableTrainer(
    @Param('trainerId', ParseUUIDPipe) trainerId: string,
    @Body() dto: DisableTrainerDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.adminTrainersService.disableTrainer(user.id, trainerId, dto.transferToId);
  }
}
