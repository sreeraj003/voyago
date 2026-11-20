import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type UserRole } from '@voyago/shared';
import { PermissionGuard, RequirePermission } from './permissions.js';

class Routes {
  @RequirePermission('users.suspend')
  suspend(this: void) {}

  undeclared(this: void) {}
}

function contextFor(handler: () => void, role: UserRole): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({
      getRequest: () => ({ user: { id: 'u', role, sessionFamilyId: 's' } }),
    }),
  } as unknown as ExecutionContext;
}

describe('PermissionGuard', () => {
  const guard = new PermissionGuard(new Reflector());
  const allowed = (handler: () => void, role: UserRole) => {
    try {
      return guard.canActivate(contextFor(handler, role));
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      return false;
    }
  };

  it('allows only roles that hold the declared permission', () => {
    const results = (['USER', 'SUPER_ADMIN', 'MODERATOR', 'SUPPORT', 'OPERATIONS'] as const).map(
      (role) => [role, allowed(Routes.prototype.suspend, role)],
    );
    expect(results).toEqual([
      ['USER', false],
      ['SUPER_ADMIN', true],
      ['MODERATOR', true],
      ['SUPPORT', false],
      ['OPERATIONS', false],
    ]);
  });

  it('fails closed when a route declares no permission', () => {
    expect(allowed(Routes.prototype.undeclared, 'SUPER_ADMIN')).toBe(false);
    expect(allowed(Routes.prototype.suspend, 'MODERATOR')).toBe(true);
  });
});
