import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ChangePasswordSchema,
  CompleteSignupSchema,
  EmailVerifyConfirmSchema,
  ForgotPasswordSchema,
  LoginSchema,
  OtpRequestSchema,
  OtpVerifySchema,
  RefreshSchema,
  RegisterSchema,
  ResetPasswordSchema,
  type SocialProvider,
  SocialProviderSchema,
  SocialSignInSchema,
} from '@voyago/shared';
import { type AuthUser, CurrentUser } from '../common/auth/current-user.decorator.js';
import { Public } from '../common/auth/public.decorator.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { AuthThrottle } from './auth-throttle.decorator.js';
import { AuthService } from './auth.service.js';

class RegisterDto extends createZodDto(RegisterSchema) {}
class LoginDto extends createZodDto(LoginSchema) {}
class RefreshDto extends createZodDto(RefreshSchema) {}
class OtpRequestDto extends createZodDto(OtpRequestSchema) {}
class OtpVerifyDto extends createZodDto(OtpVerifySchema) {}
class SocialSignInDto extends createZodDto(SocialSignInSchema) {}
class CompleteSignupDto extends createZodDto(CompleteSignupSchema) {}
class EmailVerifyConfirmDto extends createZodDto(EmailVerifyConfirmSchema) {}
class ForgotPasswordDto extends createZodDto(ForgotPasswordSchema) {}
class ResetPasswordDto extends createZodDto(ResetPasswordSchema) {}
class ChangePasswordDto extends createZodDto(ChangePasswordSchema) {}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Get('methods')
  @ApiOperation({ summary: 'Sign-in methods available on this server' })
  methods() {
    return { data: this.auth.methods() };
  }

  @Public()
  @AuthThrottle()
  @Post('register')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Create an account with email and password',
    description:
      'Returns 202 whether or not the email already has an account (no account enumeration). Sign in afterwards.',
  })
  @ApiErrorResponses(400, 409, 429)
  async register(@Body() body: RegisterDto) {
    await this.auth.register(body);
    return {
      data: {
        message: 'If this email can be used, your account is ready. Check your inbox to verify it.',
      },
    };
  }

  @Public()
  @AuthThrottle()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiErrorResponses(400, 401, 403, 429)
  async login(@Body() body: LoginDto, @Headers('user-agent') userAgent?: string) {
    return { data: await this.auth.login(body.email, body.password, userAgent) };
  }

  @Public()
  @AuthThrottle()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Exchange a refresh token for new tokens',
    description:
      'The refresh token rotates: the old one stops working. Reusing it signs out that device.',
  })
  @ApiErrorResponses(400, 401, 429)
  async refresh(@Body() body: RefreshDto, @Headers('user-agent') userAgent?: string) {
    return { data: await this.auth.refresh(body.refreshToken, userAgent) };
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Sign out this device (revokes its refresh token)' })
  async logout(@CurrentUser() user: AuthUser) {
    await this.auth.logout(user.sessionFamilyId);
  }

  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(204)
  @ApiOperation({ summary: 'Sign out every device' })
  async logoutAll(@CurrentUser() user: AuthUser) {
    await this.auth.logoutAll(user.id);
  }

  @Public()
  @AuthThrottle()
  @Post('otp/request')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send a 6-digit sign-in code by SMS' })
  @ApiErrorResponses(400, 429, 503)
  async requestOtp(@Body() body: OtpRequestDto) {
    return { data: await this.auth.requestOtp(body.phone) };
  }

  @Public()
  @AuthThrottle()
  @Post('otp/verify')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verify an SMS code',
    description: 'Signs in an existing member, or returns a signup token for a new one.',
  })
  @ApiErrorResponses(400, 403, 429, 503)
  async verifyOtp(@Body() body: OtpVerifyDto, @Headers('user-agent') userAgent?: string) {
    return { data: await this.auth.verifyOtp(body.phone, body.code, userAgent) };
  }

  @Public()
  @AuthThrottle()
  @Post('social/:provider')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in with a Google or Apple ID token' })
  @ApiErrorResponses(400, 401, 403, 409, 429, 503)
  async social(
    @Param('provider', new ZodValidationPipe(SocialProviderSchema)) provider: SocialProvider,
    @Body() body: SocialSignInDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return { data: await this.auth.socialSignIn(provider, body.idToken, userAgent) };
  }

  @Public()
  @AuthThrottle()
  @Post('signup/complete')
  @ApiOperation({ summary: 'Choose a username to finish a phone or social sign-up' })
  @ApiErrorResponses(400, 401, 409, 429)
  async completeSignup(@Body() body: CompleteSignupDto, @Headers('user-agent') userAgent?: string) {
    return {
      data: await this.auth.completeSignup(
        body.signupToken,
        { username: body.username, displayName: body.displayName },
        userAgent,
      ),
    };
  }

  @ApiBearerAuth()
  @AuthThrottle()
  @Post('email/verify/request')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send a new email verification link' })
  @ApiErrorResponses(400, 429, 503)
  async requestEmailVerification(@CurrentUser() user: AuthUser) {
    return { data: { status: await this.auth.requestEmailVerification(user.id) } };
  }

  @Public()
  @AuthThrottle()
  @Post('email/verify')
  @HttpCode(204)
  @ApiOperation({ summary: 'Confirm an email address with the token from the link' })
  @ApiErrorResponses(400, 429)
  async confirmEmailVerification(@Body() body: EmailVerifyConfirmDto) {
    await this.auth.confirmEmailVerification(body.token);
  }

  @Public()
  @AuthThrottle()
  @Post('password/forgot')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Email a password reset link',
    description: 'Returns 202 whether or not the account exists.',
  })
  @ApiErrorResponses(400, 429, 503)
  async forgotPassword(@Body() body: ForgotPasswordDto) {
    await this.auth.forgotPassword(body.email);
    return { data: { message: 'If an account uses this email, a reset link is on its way.' } };
  }

  @Public()
  @AuthThrottle()
  @Post('password/reset')
  @HttpCode(204)
  @ApiOperation({ summary: 'Set a new password with a reset token (signs out every device)' })
  @ApiErrorResponses(400, 429)
  async resetPassword(@Body() body: ResetPasswordDto) {
    await this.auth.resetPassword(body.token, body.password);
  }

  @ApiBearerAuth()
  @AuthThrottle()
  @Post('password/change')
  @HttpCode(204)
  @ApiOperation({ summary: 'Change password (signs out other devices)' })
  @ApiErrorResponses(400, 429)
  async changePassword(@CurrentUser() user: AuthUser, @Body() body: ChangePasswordDto) {
    await this.auth.changePassword(
      user.id,
      user.sessionFamilyId,
      body.currentPassword,
      body.newPassword,
    );
  }
}
