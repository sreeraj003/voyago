import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { hmacHex, safeEqualHex } from './crypto.js';
import { SMS_SENDER, type SmsSender } from './delivery/sms-sender.js';

export const OTP_TTL_SECONDS = 5 * 60;
export const OTP_MAX_ATTEMPTS = 5;
/** Per phone number: at most 3 codes per 15 minutes and 10 per day. */
const OTP_WINDOW_LIMITS = [
  { windowMs: 15 * 60 * 1000, max: 3 },
  { windowMs: 24 * 60 * 60 * 1000, max: 10 },
];

/**
 * Phone one-time codes. Only an HMAC of the code is stored; each code expires after 5 minutes,
 * allows 5 attempts and works once. Requests are limited per number (here) and per IP (route).
 */
@Injectable()
export class OtpService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    private readonly prisma: PrismaService,
  ) {}

  get enabled(): boolean {
    return this.sms.enabled;
  }

  async request(phone: string): Promise<{ expiresIn: number }> {
    this.assertEnabled();
    for (const { windowMs, max } of OTP_WINDOW_LIMITS) {
      const recent = await this.prisma.otpChallenge.count({
        where: { phone, createdAt: { gt: new Date(Date.now() - windowMs) } },
      });
      if (recent >= max) {
        throw new HttpException(
          'Too many codes requested for this number. Try again later.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    // A new code replaces any earlier one for this number.
    await this.prisma.$transaction([
      this.prisma.otpChallenge.updateMany({
        where: { phone, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
      this.prisma.otpChallenge.create({
        data: {
          phone,
          codeHash: this.hash(phone, code),
          expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
        },
      }),
    ]);
    await this.sms.send(
      phone,
      `${code} is your Voyago code. It expires in 5 minutes. Never share it.`,
    );
    return { expiresIn: OTP_TTL_SECONDS };
  }

  /** Consumes the code or throws one generic 400, whatever the reason. */
  async verify(phone: string, code: string): Promise<void> {
    this.assertEnabled();
    const invalid = new BadRequestException('Invalid or expired code');
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!challenge) throw invalid;

    // Count the attempt first, atomically, so parallel guesses cannot exceed the limit.
    const counted = await this.prisma.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null, attempts: { lt: OTP_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (counted.count !== 1) throw invalid;
    if (!safeEqualHex(challenge.codeHash, this.hash(phone, code))) throw invalid;

    const consumed = await this.prisma.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw invalid;
  }

  private hash(phone: string, code: string): string {
    return hmacHex(this.config.OTP_HMAC_SECRET, `${phone}:${code}`);
  }

  private assertEnabled(): void {
    if (!this.sms.enabled) {
      throw new ServiceUnavailableException('Phone sign-in is not available yet');
    }
  }
}
