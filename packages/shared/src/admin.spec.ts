import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSIONS,
  defaultReportSeverity,
  hasPermission,
  maskEmail,
  maskPhone,
  PERMISSIONS_BY_ROLE,
  permissionsFor,
  ReasonBodySchema,
  ResolveReportSchema,
} from './index.js';

describe('admin permissions', () => {
  it('gives members no admin permissions and super admins all of them', () => {
    expect(permissionsFor('USER')).toEqual([]);
    expect([...PERMISSIONS_BY_ROLE.SUPER_ADMIN].sort()).toEqual([...ADMIN_PERMISSIONS].sort());
  });

  it('separates moderation, support and operations duties', () => {
    expect(hasPermission('MODERATOR', 'users.suspend')).toBe(true);
    expect(hasPermission('MODERATOR', 'operators.verify')).toBe(false);
    expect(hasPermission('MODERATOR', 'audit.read')).toBe(false);
    expect(hasPermission('SUPPORT', 'reports.read')).toBe(true);
    expect(hasPermission('SUPPORT', 'reports.manage')).toBe(false);
    expect(hasPermission('SUPPORT', 'users.suspend')).toBe(false);
    expect(hasPermission('OPERATIONS', 'operators.documents')).toBe(true);
    expect(hasPermission('OPERATIONS', 'reports.read')).toBe(false);
    expect(hasPermission('OPERATIONS', 'content.moderate')).toBe(false);
    // Only super admins hand out roles.
    for (const role of ['MODERATOR', 'SUPPORT', 'OPERATIONS'] as const) {
      expect(hasPermission(role, 'users.role')).toBe(false);
    }
  });

  it('requires a real reason and a resolution note', () => {
    expect(ReasonBodySchema.safeParse({ reason: 'bad' }).success).toBe(false);
    expect(ReasonBodySchema.safeParse({ reason: '  Repeated spam  ' }).data).toEqual({
      reason: 'Repeated spam',
    });
    expect(ResolveReportSchema.safeParse({ outcome: 'ACTIONED' }).success).toBe(false);
  });

  it('starts safety and fraud reports at high severity', () => {
    expect(defaultReportSeverity('UNSAFE_BEHAVIOUR')).toBe('HIGH');
    expect(defaultReportSeverity('ILLEGAL_TRANSPORT')).toBe('HIGH');
    expect(defaultReportSeverity('HARASSMENT')).toBe('MEDIUM');
    expect(defaultReportSeverity('SPAM')).toBe('LOW');
  });

  it('masks contact details for staff screens', () => {
    expect(maskEmail('asha@example.com')).toBe('a***@example.com');
    expect(maskEmail(null)).toBeNull();
    expect(maskPhone('+919876543210')).toBe('+91******10');
  });
});
