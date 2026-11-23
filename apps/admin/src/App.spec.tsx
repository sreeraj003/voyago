import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PERMISSIONS_BY_ROLE } from '@voyago/shared';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App';
import { clearSession } from './session';
import { fakeFetch, type Route, tokens } from './test-fetch';

const STAFF_ID = '11111111-1111-4111-8111-111111111111';

function renderAt(path: string, routes: Record<string, Route>) {
  vi.stubGlobal('fetch', fakeFetch(routes));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function signInAs(routes: Record<string, Route>, path = '/') {
  renderAt(path, { 'POST /auth/login': { status: 200, body: tokens(1) }, ...routes });
  fireEvent.change(await screen.findByLabelText('Email'), {
    target: { value: 'staff@example.com' },
  });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

const support = {
  status: 200,
  body: {
    data: {
      id: STAFF_ID,
      username: 'sam',
      displayName: 'Sam',
      role: 'SUPPORT',
      permissions: PERMISSIONS_BY_ROLE.SUPPORT,
    },
  },
};

describe('App', () => {
  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it('asks staff to sign in first', async () => {
    renderAt('/', {});
    expect(await screen.findByRole('heading', { name: 'Voyago Admin' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows the server error when sign-in fails', async () => {
    renderAt('/', {
      'POST /auth/login': { status: 401, body: { message: 'Email or password is incorrect' } },
    });
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'a@b.co' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect');
  });

  it('turns away accounts that are not staff', async () => {
    await signInAs({ 'GET /admin/me': { status: 403, body: { message: 'Forbidden' } } });
    expect(await screen.findByRole('heading', { name: 'No admin access' })).toBeInTheDocument();
  });

  it('shows only the sections the role may use', async () => {
    await signInAs({ 'GET /admin/me': support });
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Overview', 'Reports', 'Members', 'Trips', 'Payments', 'Subscriptions', 'System']);
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  it('blocks pages outside the role', async () => {
    await signInAs({ 'GET /admin/me': support }, '/audit');
    expect(
      await screen.findByRole('heading', { name: 'Not available for your role' }),
    ).toBeInTheDocument();
  });

  it('lets a super admin suspend an operator package with a reason', async () => {
    const OPERATOR_ID = '22222222-2222-4222-8222-222222222222';
    const PACKAGE_ID = '33333333-3333-4333-8333-333333333333';
    const owner = { id: STAFF_ID, username: 'ravi', displayName: 'Ravi', role: 'USER' };
    const detail = (status: 'PUBLISHED' | 'SUSPENDED') => ({
      status: 200,
      body: {
        data: {
          id: OPERATOR_ID,
          displayName: 'Ghats Treks',
          legalName: 'Ghats Treks Pvt Ltd',
          slug: 'ghats-treks',
          owner,
          verificationStatus: 'VERIFIED',
          submittedAt: null,
          documentCount: 0,
          pendingDocumentCount: 0,
          createdAt: '2026-11-01T00:00:00.000Z',
          gstin: null,
          verificationNote: null,
          verifiedAt: null,
          verifiedBy: null,
          documents: [],
          packages: [
            {
              id: PACKAGE_ID,
              title: 'Kudremukh weekend trek',
              status,
              startsAt: '2026-12-05T00:30:00.000Z',
              pricePaise: 349_900,
              suspendedReason: status === 'SUSPENDED' ? 'Misleading price' : null,
            },
          ],
          history: [],
          actions: ['set_status', 'moderate_packages'],
        },
      },
    });
    const admin = {
      status: 200,
      body: {
        data: {
          id: STAFF_ID,
          username: 'ada',
          displayName: 'Ada',
          role: 'SUPER_ADMIN',
          permissions: PERMISSIONS_BY_ROLE.SUPER_ADMIN,
        },
      },
    };
    await signInAs(
      {
        'GET /admin/me': admin,
        [`GET /admin/operators/${OPERATOR_ID}`]: detail('PUBLISHED'),
        [`POST /admin/operators/${OPERATOR_ID}/packages/${PACKAGE_ID}/suspend`]:
          detail('SUSPENDED'),
      },
      `/operators/${OPERATOR_ID}`,
    );
    const row = (await screen.findByText('Kudremukh weekend trek')).closest('tr')!;
    expect(within(row).getByText('₹3,499')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Suspend' }));
    fireEvent.change(within(row).getByPlaceholderText('Reason (saved in the audit log)'), {
      target: { value: 'Misleading price' },
    });
    fireEvent.submit(within(row).getByPlaceholderText('Reason (saved in the audit log)'));
    expect(await screen.findByText('Suspended: Misleading price')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });
  it('lets operations retry a failed refund and shows the money trail', async () => {
    const BOOKING_ID = '44444444-4444-4444-8444-444444444444';
    const REFUND_ID = '55555555-5555-4555-8555-555555555555';
    const detail = (refund: 'FAILED' | 'PROCESSED') => ({
      status: 200,
      body: {
        data: {
          id: BOOKING_ID,
          status: refund === 'FAILED' ? 'CANCELLED' : 'REFUNDED',
          seats: 1,
          totalAmountPaise: 250_000,
          refundedAmountPaise: refund === 'FAILED' ? 0 : 250_000,
          currency: 'INR',
          createdAt: '2026-11-20T00:00:00.000Z',
          customer: { id: STAFF_ID, username: 'meera', displayName: 'Meera' },
          package: { id: BOOKING_ID, title: 'Kudremukh weekend trek' },
          operator: { id: BOOKING_ID, displayName: 'Ghats Treks' },
          paymentStatus: refund === 'FAILED' ? 'CAPTURED' : 'REFUNDED',
          needsAttention: refund === 'FAILED',
          unitPricePaise: 250_000,
          commissionBps: 1000,
          commissionPaise: 25_000,
          commissionTaxBps: 1800,
          commissionTaxPaise: 4_500,
          operatorPayablePaise: 220_500,
          expiresAt: null,
          confirmedAt: '2026-11-20T00:01:00.000Z',
          cancelledAt: '2026-11-21T00:00:00.000Z',
          cancelledBy: 'CUSTOMER',
          cancellationReason: null,
          refundTiers: [{ hoursBefore: 168, refundPercent: 100 }],
          payments: [
            {
              id: BOOKING_ID,
              provider: 'razorpay',
              providerOrderId: 'order_1',
              providerPaymentId: 'pay_1',
              status: refund === 'FAILED' ? 'CAPTURED' : 'REFUNDED',
              amountPaise: 250_000,
              refundedAmountPaise: refund === 'FAILED' ? 0 : 250_000,
              providerFeePaise: 5_900,
              providerTaxPaise: 900,
              method: 'upi',
              failureReason: null,
              capturedAt: '2026-11-20T00:01:00.000Z',
              createdAt: '2026-11-20T00:00:00.000Z',
            },
          ],
          refunds: [
            {
              id: REFUND_ID,
              amountPaise: 250_000,
              status: refund,
              initiator: 'CUSTOMER',
              refundPercent: 100,
              createdAt: '2026-11-21T00:00:00.000Z',
              processedAt: refund === 'FAILED' ? null : '2026-11-21T01:00:00.000Z',
              providerRefundId: null,
              reason: 'Cancelled by the customer',
              failureReason: refund === 'FAILED' ? 'Refund could not be processed' : null,
            },
          ],
          ledger: [
            {
              id: REFUND_ID,
              kind: 'GROSS',
              amountPaise: 250_000,
              currency: 'INR',
              createdAt: '2026-11-20T00:01:00.000Z',
            },
          ],
          events: [],
          actions: refund === 'FAILED' ? ['reconcile', 'retry_refund'] : ['reconcile'],
        },
      },
    });
    const ops = {
      status: 200,
      body: {
        data: {
          id: STAFF_ID,
          username: 'oli',
          displayName: 'Oli',
          role: 'OPERATIONS',
          permissions: PERMISSIONS_BY_ROLE.OPERATIONS,
        },
      },
    };
    await signInAs(
      {
        'GET /admin/me': ops,
        [`GET /admin/bookings/${BOOKING_ID}`]: detail('FAILED'),
        [`POST /admin/refunds/${REFUND_ID}/retry`]: detail('PROCESSED'),
      },
      `/bookings/${BOOKING_ID}`,
    );
    expect(await screen.findByText('Refund could not be processed')).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('Gross')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Processed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('lets operations end a subscription now and refund the last payment', async () => {
    const SUB_ID = '66666666-6666-4666-8666-666666666666';
    const PAY_ID = '77777777-7777-4777-8777-777777777777';
    const sub = (ended: boolean) => ({
      status: 200,
      body: {
        data: {
          id: SUB_ID,
          status: ended ? 'CANCELLED' : 'ACTIVE',
          plan: { code: 'ORGANISER_PRO_MONTHLY', tier: 'ORGANISER_PRO', name: 'Organiser Pro' },
          pricePaise: 69_900,
          currency: 'INR',
          currentPeriodStart: '2026-11-20T00:00:00.000Z',
          currentPeriodEnd: ended ? '2026-11-23T00:00:00.000Z' : '2026-12-20T00:00:00.000Z',
          cancelAtPeriodEnd: ended,
          cancelledAt: ended ? '2026-11-23T00:00:00.000Z' : null,
          renewsAt: ended ? null : '2026-12-20T00:00:00.000Z',
          entitled: !ended,
          payments: [
            {
              id: PAY_ID,
              amountPaise: 69_900,
              refundedAmountPaise: ended ? 69_900 : 0,
              currency: 'INR',
              status: ended ? 'REFUNDED' : 'CAPTURED',
              failureReason: null,
              createdAt: '2026-11-20T00:00:00.000Z',
              capturedAt: '2026-11-20T00:00:00.000Z',
            },
          ],
          createdAt: '2026-11-20T00:00:00.000Z',
          user: { id: STAFF_ID, username: 'meera', displayName: 'Meera' },
          provider: 'razorpay',
          providerSubscriptionId: 'sub_1',
          cancellationReason: ended ? 'Ended by support: Charged by mistake' : null,
          actions: ended ? ['reconcile'] : ['reconcile', 'cancel_now', 'refund_last'],
        },
      },
    });
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      fakeFetch(
        {
          'POST /auth/login': { status: 200, body: tokens(1) },
          'GET /admin/me': {
            status: 200,
            body: {
              data: {
                id: STAFF_ID,
                username: 'oli',
                displayName: 'Oli',
                role: 'OPERATIONS',
                permissions: PERMISSIONS_BY_ROLE.OPERATIONS,
              },
            },
          },
          [`GET /admin/subscriptions/${SUB_ID}`]: sub(false),
          [`POST /admin/subscriptions/${SUB_ID}/end`]: sub(true),
        },
        calls,
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/subscriptions/${SUB_ID}`]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'staff@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.click(await screen.findByRole('button', { name: 'End now and refund ₹699' }));
    fireEvent.change(screen.getByPlaceholderText('Reason (saved in the audit log)'), {
      target: { value: 'Charged by mistake' },
    });
    fireEvent.submit(screen.getByPlaceholderText('Reason (saved in the audit log)'));
    expect(await screen.findByText('Paid features off')).toBeInTheDocument();
    expect(calls).toContain(`POST /admin/subscriptions/${SUB_ID}/end`);
    expect(screen.queryByRole('button', { name: 'End now' })).not.toBeInTheDocument();
  });

  it('shows operations the business metrics and the system status', async () => {
    const ops = {
      status: 200,
      body: {
        data: {
          id: STAFF_ID,
          username: 'olu',
          displayName: 'Olu',
          role: 'OPERATIONS',
          permissions: PERMISSIONS_BY_ROLE.OPERATIONS,
        },
      },
    };
    const metrics = {
      generatedAt: '2026-11-23T08:00:00.000Z',
      period: { from: '2026-10-25', to: '2026-11-23', days: 30 },
      northStar: {
        label: 'Completed trips with at least two people, per month',
        months: [
          { month: '2026-10', value: 12 },
          { month: '2026-11', value: 17 },
        ],
      },
      engagement: {
        dau: 40,
        mau: 400,
        stickiness: 10,
        daily: [{ date: '2026-11-23', active: 40 }],
      },
      growth: {
        registrations: 120,
        registrationConversion: 25.5,
        profileCompletion: 60,
        retention30: null,
      },
      trips: {
        created: 30,
        published: 25,
        withJoinRequests: 80,
        completionRate: 90,
        repeatOrganiserRate: 40,
      },
      money: {
        currency: 'INR',
        gmvPaise: 12_500_000,
        commissionPaise: 1_000_000,
        mrrPaise: 69_900,
        subscriptionRevenuePaise: 69_900,
        refundRate: 2,
        paymentSuccessRate: 95,
        contributionMarginPaise: 900_000,
        providerFeesPaise: 169_900,
      },
      events: [{ name: 'trip_completed', count: 17 }],
    };
    const system = {
      generatedAt: '2026-11-23T08:00:00.000Z',
      version: '0.1.0',
      uptimeSeconds: 7_200,
      dependencies: [
        { name: 'database', up: true, latencyMs: 3 },
        { name: 'redis', up: false, latencyMs: null },
      ],
      http: { requests: 1000, serverErrors: 2, p50Ms: 12, p95Ms: 80, slowest: [] },
      jobs: [
        {
          name: 'payment-reconciliation',
          description: 'Reconciles pending payments',
          intervalSeconds: 60,
          lastStartedAt: '2026-11-23T07:59:00.000Z',
          lastSuccessAt: '2026-11-23T07:50:00.000Z',
          lastError: 'Provider timed out',
          lastErrorAt: '2026-11-23T07:59:00.000Z',
          consecutiveFailures: 3,
          runs: 50,
          failures: 3,
          healthy: false,
        },
      ],
      payments: {
        stuckWebhooks: 1,
        invalidSignatures24h: 0,
        failedRefunds: 0,
        amountMismatches: 0,
      },
      moderation: { open: 4, overdue: 1, oldestOpenHours: 30 },
      clientErrors24h: 5,
    };
    await signInAs(
      {
        'GET /admin/me': ops,
        'GET /admin/metrics': { status: 200, body: { data: metrics } },
        'GET /admin/system': { status: 200, body: { data: system } },
      },
      '/metrics',
    );
    expect(await screen.findByRole('heading', { name: 'Metrics' })).toBeInTheDocument();
    expect(await screen.findByText('Completed with 2+ people')).toBeInTheDocument();
    expect(screen.getByText('25.5%')).toBeInTheDocument();
    expect(screen.getByText('₹1,25,000')).toBeInTheDocument();
    expect(screen.getByText('No data')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'System' }));
    expect(await screen.findByText('Provider timed out')).toBeInTheDocument();
    expect(screen.getByText('Down')).toBeInTheDocument();
    expect(screen.getByText('Failing')).toBeInTheDocument();
    expect(screen.getByText('Background jobs (1 need attention)')).toBeInTheDocument();
  });

  it('keeps business metrics from support staff', async () => {
    await signInAs({ 'GET /admin/me': support }, '/metrics');
    expect(
      await screen.findByRole('heading', { name: 'Not available for your role' }),
    ).toBeInTheDocument();
  });
});
