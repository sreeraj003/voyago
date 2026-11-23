import 'reflect-metadata';
import 'dotenv/config';
import { type INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import { type AuthTokens } from '@voyago/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { IS_PUBLIC_KEY } from '../src/common/auth/public.decorator.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { bearer, registerAndLogin, startAuthApp } from './support/auth-helpers.js';

/**
 * Walks every route the app serves and checks the defaults that protect it:
 * - every route not marked @Public answers 401 without a token;
 * - every /admin route answers 403 to an ordinary member;
 * - the public routes are exactly the reviewed list below, so a new one fails this test
 *   until someone looks at it.
 */
type Route = { method: string; path: string; isPublic: boolean };

const REVIEWED_PUBLIC = [
  // Probes and monitoring (/metrics needs its own token; client-errors carries no account).
  'GET /api/v1/health',
  'GET /api/v1/health/live',
  'GET /api/v1/health/ready',
  'GET /api/v1/metrics',
  'POST /api/v1/client-errors',
  // Signing in and up (rate limited per IP and per account).
  'GET /api/v1/auth/methods',
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/email/verify',
  'POST /api/v1/auth/password/forgot',
  'POST /api/v1/auth/password/reset',
  'POST /api/v1/auth/otp/request',
  'POST /api/v1/auth/otp/verify',
  'POST /api/v1/auth/social/:provider',
  'POST /api/v1/auth/signup/complete',
  // Payment pages opened from a signed, short-lived link; webhooks verified by signature.
  'GET /api/v1/checkout/:id',
  'POST /api/v1/checkout/:id/razorpay',
  'GET /api/v1/checkout/subscriptions/:id',
  'POST /api/v1/checkout/subscriptions/:id/razorpay',
  'POST /api/v1/webhooks/razorpay',
];

function collectRoutes(app: INestApplication<App>): Route[] {
  const modules = app.get(ModulesContainer, { strict: false });
  const scanner = new MetadataScanner();
  const routes: Route[] = [];
  const controllers = [...modules.values()].flatMap((m) => [...m.controllers.values()]);
  for (const wrapper of controllers) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) continue;
    const base = [Reflect.getMetadata(PATH_METADATA, metatype) as string | string[] | undefined]
      .flat()
      .filter((p): p is string => typeof p === 'string');
    const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, metatype) === true;
    const proto = Object.getPrototypeOf(instance) as object;
    for (const name of scanner.getAllMethodNames(proto)) {
      const handler = (proto as Record<string, unknown>)[name] as object;
      const sub = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (sub === undefined || verb === undefined) continue;
      const isPublic = classPublic || Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true;
      for (const prefix of base.length > 0 ? base : ['']) {
        for (const tail of [sub].flat()) {
          const path = `/api/v1/${[prefix, tail].filter(Boolean).join('/')}`
            .replace(/\/+/g, '/')
            .replace(/\/$/, '');
          routes.push({ method: RequestMethod[verb], path, isPublic });
        }
      }
    }
  }
  return routes;
}

/** Fills path parameters with a random UUID (or a slug-like value for slugs and usernames). */
const concrete = (path: string) =>
  path.replace(/:(\w+)/g, (_m, name: string) =>
    /slug|username/i.test(name) ? `sweep-${randomUUID().slice(0, 8)}` : randomUUID(),
  );

describe('authorization sweep over every route (e2e)', () => {
  let app: INestApplication<App>;
  let member: AuthTokens;
  let memberId: string;
  let routes: Route[];
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await startAuthApp();
    const name = `sw_${randomUUID().slice(0, 6)}`;
    member = await registerAndLogin(app, { email: `${name}@example.test`, username: name });
    memberId = (await app.get(PrismaService).user.findUniqueOrThrow({ where: { username: name } }))
      .id;
    routes = collectRoutes(app);
  });

  afterAll(async () => {
    await app.get(PrismaService).user.deleteMany({ where: { id: memberId } });
    await app?.close();
  });

  it('finds the routes', () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it('has no public route beyond the reviewed list', () => {
    const found = routes
      .filter((r) => r.isPublic)
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(found).toEqual([...REVIEWED_PUBLIC].sort());
  });

  it('refuses every other route without a token', async () => {
    const leaks: string[] = [];
    for (const route of routes.filter((r) => !r.isPublic)) {
      const method = route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
      const res = await http()[method](concrete(route.path)).send({});
      if (res.status !== 401) leaks.push(`${route.method} ${route.path} -> ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('refuses every admin route to an ordinary member', async () => {
    const leaks: string[] = [];
    for (const route of routes.filter((r) => r.path.startsWith('/api/v1/admin'))) {
      const method = route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
      const res = await http()
        [method](concrete(route.path))
        .set('authorization', bearer(member))
        .send({});
      if (res.status !== 403) leaks.push(`${route.method} ${route.path} -> ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('rejects a forged or expired-looking token everywhere', async () => {
    const forged = `${member.accessToken.slice(0, -4)}AAAA`;
    const sample = routes.filter((r) => !r.isPublic && r.method === 'GET').slice(0, 40);
    for (const route of sample) {
      const res = await http().get(concrete(route.path)).set('authorization', `Bearer ${forged}`);
      expect(res.status, route.path).toBe(401);
    }
  });
});
