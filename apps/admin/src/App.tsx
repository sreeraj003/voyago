import { useQueryClient } from '@tanstack/react-query';
import { type AdminPermission } from '@voyago/shared';
import { type ReactNode, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ApiError, refreshSession, signOut } from './api';
import { ErrorText, label, Loading } from './components';
import { AuditPage } from './pages/AuditPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { OperatorDetailPage } from './pages/OperatorDetailPage';
import { OperatorsPage } from './pages/OperatorsPage';
import { ReportDetailPage } from './pages/ReportDetailPage';
import { ReportsPage } from './pages/ReportsPage';
import { TripDetailPage } from './pages/TripDetailPage';
import { TripsPage } from './pages/TripsPage';
import { UserDetailPage } from './pages/UserDetailPage';
import { UsersPage } from './pages/UsersPage';
import { storedRefreshToken } from './session';
import { useAdmin } from './use-admin';

const NAV: { to: string; title: string; permission: AdminPermission }[] = [
  { to: '/', title: 'Overview', permission: 'dashboard.view' },
  { to: '/reports', title: 'Reports', permission: 'reports.read' },
  { to: '/users', title: 'Members', permission: 'users.read' },
  { to: '/trips', title: 'Trips', permission: 'trips.read' },
  { to: '/operators', title: 'Operators', permission: 'operators.read' },
  { to: '/audit', title: 'Audit log', permission: 'audit.read' },
];

export function App() {
  const { session, me, can } = useAdmin();
  const client = useQueryClient();
  // A reload keeps the refresh token for this tab; exchange it once for a new session.
  const [restoring, setRestoring] = useState(() => !session && storedRefreshToken() !== null);
  useEffect(() => {
    if (!restoring) return;
    void refreshSession().finally(() => setRestoring(false));
  }, [restoring]);

  const leave = async () => {
    await signOut();
    client.clear();
  };

  if (restoring) return <Loading />;
  if (!session) return <LoginPage />;
  if (me.isPending) return <Loading />;
  if (!me.data) {
    const denied = me.error instanceof ApiError && me.error.status === 403;
    return (
      <main className="login">
        <div className="card">
          <h1>{denied ? 'No admin access' : 'Could not load your account'}</h1>
          {denied ? (
            <p>This account is not a Voyago staff account.</p>
          ) : (
            <ErrorText error={me.error} />
          )}
          <button type="button" onClick={() => void leave()}>
            Sign out
          </button>
        </div>
      </main>
    );
  }

  const guard = (permission: AdminPermission, page: ReactNode) =>
    can(permission) ? page : <NoAccess />;

  return (
    <div className="layout">
      <header className="topbar">
        <strong>Voyago Admin</strong>
        <nav aria-label="Main">
          {NAV.filter((item) => can(item.permission)).map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'}>
              {item.title}
            </NavLink>
          ))}
        </nav>
        <span className="me">
          {me.data.displayName} <span className="muted">({label(me.data.role)})</span>
          <button type="button" className="link" onClick={() => void leave()}>
            Sign out
          </button>
        </span>
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/reports" element={guard('reports.read', <ReportsPage />)} />
          <Route path="/reports/:id" element={guard('reports.read', <ReportDetailPage />)} />
          <Route path="/users" element={guard('users.read', <UsersPage />)} />
          <Route path="/users/:id" element={guard('users.read', <UserDetailPage />)} />
          <Route path="/trips" element={guard('trips.read', <TripsPage />)} />
          <Route path="/trips/:id" element={guard('trips.read', <TripDetailPage />)} />
          <Route path="/operators" element={guard('operators.read', <OperatorsPage />)} />
          <Route path="/operators/:id" element={guard('operators.read', <OperatorDetailPage />)} />
          <Route path="/audit" element={guard('audit.read', <AuditPage />)} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<h1>Page not found</h1>} />
        </Routes>
      </main>
    </div>
  );
}

function NoAccess() {
  return (
    <>
      <h1>Not available for your role</h1>
      <p className="muted">Ask a super admin if you need access.</p>
    </>
  );
}
