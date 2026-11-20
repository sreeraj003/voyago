import {
  type AddOperatorDocumentInput,
  type CreateOperatorInput,
  type CreatePackageInput,
  type MyOperator,
  MyOperatorSchema,
  type OperatorDashboard,
  OperatorDashboardSchema,
  type OwnPackage,
  OwnPackageSchema,
  PackageCardSchema,
  type PackageDetail,
  PackageDetailSchema,
  type PackageQuestion,
  PackageQuestionSchema,
  type PackagesQuery,
  pageEnvelope,
  type PageResponse,
  type PublicOperator,
  PublicOperatorSchema,
  type PackageCard,
  type UpdateOperatorInput,
  type UpdatePackageInput,
} from '@voyago/shared';
import { z } from 'zod';
import { ApiRequestError, apiRequest } from './http';

const CardPage = pageEnvelope(PackageCardSchema);
const QuestionPage = pageEnvelope(PackageQuestionSchema);

const qs = (query: Record<string, unknown>) => {
  const parts = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
};

// ── Browsing ────────────────────────────────────────────────────────────────

export const listPackages = async (query: PackagesQuery): Promise<PageResponse<PackageCard>> =>
  CardPage.parse(
    await apiRequest(`/packages${qs({ limit: 20, ...query })}`, { schema: z.unknown(), raw: true }),
  );

export const getPackage = (id: string): Promise<PackageDetail> =>
  apiRequest(`/packages/${id}`, { schema: PackageDetailSchema });

export const getPackageQuestions = (id: string): Promise<PackageQuestion[]> =>
  apiRequest(`/packages/${id}/questions`, { schema: z.array(PackageQuestionSchema) });

export const askQuestion = (id: string, question: string): Promise<PackageQuestion> =>
  apiRequest(`/packages/${id}/questions`, {
    method: 'POST',
    body: { question },
    schema: PackageQuestionSchema,
  });

export const getOperatorProfile = (slug: string): Promise<PublicOperator> =>
  apiRequest(`/operators/${encodeURIComponent(slug)}`, { schema: PublicOperatorSchema });

// ── My business ─────────────────────────────────────────────────────────────

export const myOperatorKey = ['my-operator'] as const;

/** The member's business, or null when they have not created one. */
export async function getMyOperator(): Promise<MyOperator | null> {
  try {
    return await apiRequest('/me/operator', { schema: MyOperatorSchema });
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    throw error;
  }
}

export const createOperator = (input: CreateOperatorInput): Promise<MyOperator> =>
  apiRequest('/me/operator', { method: 'POST', body: input, schema: MyOperatorSchema });

export const updateOperator = (input: UpdateOperatorInput): Promise<MyOperator> =>
  apiRequest('/me/operator', { method: 'PATCH', body: input, schema: MyOperatorSchema });

export const addOperatorDocument = (input: AddOperatorDocumentInput): Promise<MyOperator> =>
  apiRequest('/me/operator/documents', { method: 'POST', body: input, schema: MyOperatorSchema });

export const removeOperatorDocument = (id: string): Promise<MyOperator> =>
  apiRequest(`/me/operator/documents/${id}`, { method: 'DELETE', schema: MyOperatorSchema });

export const submitOperator = (): Promise<MyOperator> =>
  apiRequest('/me/operator/submit', { method: 'POST', schema: MyOperatorSchema });

export const getDashboard = (): Promise<OperatorDashboard> =>
  apiRequest('/me/operator/dashboard', { schema: OperatorDashboardSchema });

export const listMyPackages = (): Promise<OwnPackage[]> =>
  apiRequest('/me/operator/packages', { schema: z.array(OwnPackageSchema) });

export const getMyPackage = (id: string): Promise<OwnPackage> =>
  apiRequest(`/me/operator/packages/${id}`, { schema: OwnPackageSchema });

export const createPackage = (input: CreatePackageInput): Promise<OwnPackage> =>
  apiRequest('/me/operator/packages', { method: 'POST', body: input, schema: OwnPackageSchema });

export const updatePackage = (id: string, input: UpdatePackageInput): Promise<OwnPackage> =>
  apiRequest(`/me/operator/packages/${id}`, {
    method: 'PATCH',
    body: input,
    schema: OwnPackageSchema,
  });

export const packageAction = (
  id: string,
  action: 'publish' | 'unpublish' | 'archive',
): Promise<OwnPackage> =>
  apiRequest(`/me/operator/packages/${id}/${action}`, {
    method: 'POST',
    schema: OwnPackageSchema,
  });

export const listOperatorQuestions = async (
  unanswered: boolean,
  cursor?: string,
): Promise<PageResponse<PackageQuestion>> =>
  QuestionPage.parse(
    await apiRequest(
      `/me/operator/questions${qs({ limit: 20, unanswered: unanswered ? 'true' : undefined, cursor })}`,
      { schema: z.unknown(), raw: true },
    ),
  );

export const answerQuestion = (id: string, answer: string): Promise<PackageQuestion> =>
  apiRequest(`/package-questions/${id}/answer`, {
    method: 'POST',
    body: { answer },
    schema: PackageQuestionSchema,
  });

export const hideQuestion = (id: string): Promise<PackageQuestion> =>
  apiRequest(`/package-questions/${id}/hide`, { method: 'POST', schema: PackageQuestionSchema });
