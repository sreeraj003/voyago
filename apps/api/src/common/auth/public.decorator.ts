import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'voyago:isPublic';

/** Marks a route or controller as reachable without authentication. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
