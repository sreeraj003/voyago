import {
  AdminBookingDetailSchema,
  AdminBookingPageSchema,
  type AdminBookingsQuery,
  type AdminRefundInput,
  type AdminMe,
  AdminMeSchema,
  AdminOperatorDetailSchema,
  AdminOperatorPageSchema,
  type AdminOperatorsQuery,
  AdminReportDetailSchema,
  AdminReportPageSchema,
  type AdminReportsQuery,
  AdminTripDetailSchema,
  AdminTripPageSchema,
  type AdminTripsQuery,
  AdminUserDetailSchema,
  AdminUserPageSchema,
  type AdminUsersQuery,
  type AdminEndSubscriptionInput,
  AdminPlanSchema,
  AdminSubscriptionPageSchema,
  AdminSubscriptionSchema,
  type AdminSubscriptionsQuery,
  AuditPageSchema,
  type AuditQuery,
  DashboardSchema,
  DocumentLinkSchema,
  ReconcileResultSchema,
  type ResolveReportInput,
  type ReviewDocumentInput,
  type SetOperatorStatusInput,
  type SetRoleInput,
  StaffPersonSchema,
  type TriageReportInput,
  type UpdatePlanInput,
} from '@voyago/shared';
import { z } from 'zod';
import { api } from './api';

/** Query string from defined values only. */
export function qs(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

const post = <T>(path: string, body: unknown, schema: z.ZodType<T>) =>
  api(path, { method: 'POST', body, schema });

export const adminApi = {
  me: (): Promise<AdminMe> => api('/admin/me', { schema: AdminMeSchema }),
  dashboard: () => api('/admin/dashboard', { schema: DashboardSchema }),
  staff: () => api('/admin/staff', { schema: z.array(StaffPersonSchema) }),
  audit: (query: AuditQuery) =>
    api(`/admin/audit${qs(query)}`, { schema: AuditPageSchema, envelope: 'whole' }),

  users: (query: AdminUsersQuery) =>
    api(`/admin/users${qs(query)}`, { schema: AdminUserPageSchema, envelope: 'whole' }),
  user: (id: string) => api(`/admin/users/${id}`, { schema: AdminUserDetailSchema }),
  suspend: (id: string, reason: string) =>
    post(`/admin/users/${id}/suspend`, { reason }, AdminUserDetailSchema),
  restore: (id: string, reason: string) =>
    post(`/admin/users/${id}/restore`, { reason }, AdminUserDetailSchema),
  setRole: (id: string, input: SetRoleInput) =>
    post(`/admin/users/${id}/role`, input, AdminUserDetailSchema),

  trips: (query: AdminTripsQuery) =>
    api(`/admin/trips${qs(query)}`, { schema: AdminTripPageSchema, envelope: 'whole' }),
  trip: (id: string) => api(`/admin/trips/${id}`, { schema: AdminTripDetailSchema }),
  tripAction: (id: string, action: 'hide' | 'unhide' | 'cancel', reason: string) =>
    post(`/admin/trips/${id}/${action}`, { reason }, AdminTripDetailSchema),
  removePost: (id: string, reason: string) =>
    api(`/admin/posts/${id}/remove`, { method: 'POST', body: { reason } }),
  removeMessage: (id: string, reason: string) =>
    api(`/admin/messages/${id}/remove`, { method: 'POST', body: { reason } }),

  reports: (query: AdminReportsQuery) =>
    api(`/admin/reports${qs(query)}`, { schema: AdminReportPageSchema, envelope: 'whole' }),
  report: (id: string) => api(`/admin/reports/${id}`, { schema: AdminReportDetailSchema }),
  assignReport: (id: string, assigneeId: string | null) =>
    post(`/admin/reports/${id}/assign`, { assigneeId }, AdminReportDetailSchema),
  triageReport: (id: string, input: TriageReportInput) =>
    api(`/admin/reports/${id}`, { method: 'PATCH', body: input, schema: AdminReportDetailSchema }),
  resolveReport: (id: string, input: ResolveReportInput) =>
    post(`/admin/reports/${id}/resolve`, input, AdminReportDetailSchema),
  reopenReport: (id: string, reason: string) =>
    post(`/admin/reports/${id}/reopen`, { reason }, AdminReportDetailSchema),

  operators: (query: AdminOperatorsQuery) =>
    api(`/admin/operators${qs(query)}`, { schema: AdminOperatorPageSchema, envelope: 'whole' }),
  operator: (id: string) => api(`/admin/operators/${id}`, { schema: AdminOperatorDetailSchema }),
  documentLink: (id: string, documentId: string) =>
    post(`/admin/operators/${id}/documents/${documentId}/link`, {}, DocumentLinkSchema),
  reviewDocument: (id: string, documentId: string, input: ReviewDocumentInput) =>
    post(`/admin/operators/${id}/documents/${documentId}/review`, input, AdminOperatorDetailSchema),
  setOperatorStatus: (id: string, input: SetOperatorStatusInput) =>
    post(`/admin/operators/${id}/status`, input, AdminOperatorDetailSchema),
  suspendPackage: (id: string, packageId: string, reason: string) =>
    post(
      `/admin/operators/${id}/packages/${packageId}/suspend`,
      { reason },
      AdminOperatorDetailSchema,
    ),
  restorePackage: (id: string, packageId: string, reason: string) =>
    post(
      `/admin/operators/${id}/packages/${packageId}/restore`,
      { reason },
      AdminOperatorDetailSchema,
    ),

  bookings: (query: AdminBookingsQuery) =>
    api(`/admin/bookings${qs(query)}`, { schema: AdminBookingPageSchema, envelope: 'whole' }),
  booking: (id: string) => api(`/admin/bookings/${id}`, { schema: AdminBookingDetailSchema }),
  reconcileBooking: (id: string) =>
    post(`/admin/bookings/${id}/reconcile`, {}, ReconcileResultSchema),
  refundBooking: (id: string, input: AdminRefundInput) =>
    post(`/admin/bookings/${id}/refund`, input, AdminBookingDetailSchema),
  retryRefund: (refundId: string) =>
    post(`/admin/refunds/${refundId}/retry`, {}, AdminBookingDetailSchema),

  plans: () => api('/admin/subscription-plans', { schema: z.array(AdminPlanSchema) }),
  updatePlan: (id: string, input: UpdatePlanInput) =>
    api(`/admin/subscription-plans/${id}`, {
      method: 'PATCH',
      body: input,
      schema: AdminPlanSchema,
    }),
  subscriptions: (query: AdminSubscriptionsQuery) =>
    api(`/admin/subscriptions${qs(query)}`, {
      schema: AdminSubscriptionPageSchema,
      envelope: 'whole',
    }),
  subscription: (id: string) =>
    api(`/admin/subscriptions/${id}`, { schema: AdminSubscriptionSchema }),
  reconcileSubscription: (id: string) =>
    post(
      `/admin/subscriptions/${id}/reconcile`,
      {},
      z.object({ result: z.string(), subscription: AdminSubscriptionSchema }),
    ),
  endSubscription: (id: string, input: AdminEndSubscriptionInput) =>
    post(`/admin/subscriptions/${id}/end`, input, AdminSubscriptionSchema),
};
