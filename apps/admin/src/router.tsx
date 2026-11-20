import { createBrowserRouter, RouterProvider } from 'react-router';
import { RequireAuth, RequirePermission } from './auth/guards';
import { AdminLayout } from './layouts/AdminLayout';
import { LoginPage } from './pages/LoginPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { DashboardPage } from './pages/DashboardPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { UsersPage } from './pages/system/UsersPage';
import { RolesPage } from './pages/system/RolesPage';
import { TeamsPage } from './pages/system/TeamsPage';
import { AuditLogsPage } from './pages/system/AuditLogsPage';

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/change-password',
    element: (
      <RequireAuth allowPendingPassword>
        <ChangePasswordPage forced />
      </RequireAuth>
    ),
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AdminLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <DashboardPage /> },
      {
        path: 'system/users',
        element: (
          <RequirePermission permission="system:user:read">
            <UsersPage />
          </RequirePermission>
        ),
      },
      {
        path: 'system/roles',
        element: (
          <RequirePermission permission="system:role:read">
            <RolesPage />
          </RequirePermission>
        ),
      },
      {
        path: 'system/teams',
        element: (
          <RequirePermission permission="system:user:read">
            <TeamsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'system/audit-logs',
        element: (
          <RequirePermission permission="system:audit:read">
            <AuditLogsPage />
          </RequirePermission>
        ),
      },
      { path: 'account/password', element: <ChangePasswordPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
