import {
  Controller,
  Post,
  Get,
  Body,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { SessionGuard, SessionUser } from './session.guard';
import { CurrentUser } from './current-user.decorator';
import { RegisterMemberDto } from './dto/register-member.dto';
import { LoginMemberDto } from './dto/login-member.dto';
import { RecoverMemberDto } from './dto/recover-member.dto';
import { LoginAdminDto } from './dto/login-admin.dto';
import { SetupAdminDto } from './dto/setup-admin.dto';

const COOKIE_NAME = 'session';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

function setSessionCookie(res: Response, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('member/register')
  async registerMember(
    @Body() dto: RegisterMemberDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { memberCode, recoveryCode, sessionToken } = await this.authService.registerMember(dto);
    setSessionCookie(res, sessionToken);
    return { memberCode, recoveryCode };
  }

  @Post('member/login')
  @HttpCode(HttpStatus.OK)
  async loginMember(
    @Body() dto: LoginMemberDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { memberCode, displayName, sessionToken } = await this.authService.loginMember(dto);
    setSessionCookie(res, sessionToken);
    return { memberCode, displayName };
  }

  @Post('member/forgot')
  @HttpCode(HttpStatus.OK)
  async recoverMember(
    @Body() dto: RecoverMemberDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { memberCode, recoveryCode, sessionToken } = await this.authService.recoverMember(dto);
    setSessionCookie(res, sessionToken);
    return { memberCode, recoveryCode };
  }

  @Post('admin/setup')
  async setupAdmin(
    @Body() dto: SetupAdminDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { username, sessionToken } = await this.authService.setupAdmin(dto);
    setSessionCookie(res, sessionToken);
    return { username };
  }

  @Post('admin/login')
  @HttpCode(HttpStatus.OK)
  async loginAdmin(
    @Body() dto: LoginAdminDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { username, sessionToken } = await this.authService.loginAdmin(dto);
    setSessionCookie(res, sessionToken);
    return { username };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  async logout(
    @CurrentUser() user: SessionUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.revokeSession(user.sessionId);
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentUser() user: SessionUser) {
    if (user.type === 'member') {
      return { type: user.type, id: user.id, memberCode: user.memberCode, displayName: user.displayName };
    }
    return { type: user.type, id: user.id, username: user.username };
  }
}