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
    ).toEqual(['Overview', 'Reports', 'Members', 'Trips']);
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
});
