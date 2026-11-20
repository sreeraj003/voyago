import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { CursorPageQuerySchema, UuidSchema } from '@voyago/shared';
import { z } from 'zod';
import { Public } from '../../src/common/auth/public.decorator.js';
import { decodeCursor, toPage } from '../../src/common/pagination/cursor.js';
import { ZodValidationPipe } from '../../src/common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../../src/common/validation/zod-dto.js';
import { PrismaService } from '../../src/database/prisma.service.js';

/**
 * Test-only routes mounted on the real app (via createApp's extraModules) to exercise the
 * global conventions end to end. Never imported by the application itself.
 */
class EchoDto extends createZodDto(
  z.object({ title: z.string().min(3), count: z.number().int().min(1).optional() }),
) {}

class ListQueryDto extends createZodDto(
  CursorPageQuerySchema.extend({ prefix: z.string().regex(/^[a-z0-9_]{3,20}$/) }),
) {}

class CreateUserDto extends createZodDto(
  z.object({ username: z.string(), displayName: z.string() }),
) {}

@Controller('_test')
class TestRoutesController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Post('echo')
  echo(@Body() body: EchoDto) {
    return { data: body };
  }

  @Public()
  @Get('items/:id')
  item(@Param('id', new ZodValidationPipe(UuidSchema)) id: string) {
    return { data: { id } };
  }

  @Public()
  @Get('users')
  async users(@Query() query: ListQueryDto) {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.user.findMany({
      where: {
        username: { startsWith: query.prefix },
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: { id: true, username: true, createdAt: true },
    });
    return toPage(rows, query.limit);
  }

  @Public()
  @Post('users')
  async createUser(@Body() body: CreateUserDto) {
    return { data: await this.prisma.user.create({ data: body, select: { id: true } }) };
  }

  @Public()
  @Post('users/:id/follow-self')
  async followSelf(@Param('id', new ZodValidationPipe(UuidSchema)) id: string) {
    await this.prisma.follow.create({ data: { followerId: id, followeeId: id } });
    return { data: null };
  }

  /** Not @Public(): must be rejected by the global auth guard. */
  @Get('private')
  privateRoute() {
    return { data: 'should never be returned' };
  }
}

@Module({ controllers: [TestRoutesController] })
export class TestRoutesModule {}
