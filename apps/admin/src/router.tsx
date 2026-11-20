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
import { CustomersPage } from './pages/customers/CustomersPage';
import { CustomerDetailPage } from './pages/customers/CustomerDetailPage';
import { CatalogPage } from './pages/catalog/CatalogPage';
import { OrdersPage } from './pages/orders/OrdersPage';
import { NewOrderPage } from './pages/orders/NewOrderPage';
import { OrderDetailPage } from './pages/orders/OrderDetailPage';
import { TasksPage } from './pages/tasks/TasksPage';
import { SubscriptionsPage } from './pages/subscriptions/SubscriptionsPage';
import { SubscriptionDetailPage } from './pages/subscriptions/SubscriptionDetailPage';
import { SettingsPage } from './pages/settings/SettingsPage';

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
        path: 'customers',
        element: (
          <RequirePermission permission="customer:read">
            <CustomersPage />
          </RequirePermission>
        ),
      },
      {
        path: 'customers/:id',
        element: (
          <RequirePermission permission="customer:read">
            <CustomerDetailPage />
          </RequirePermission>
        ),
      },
      {
        path: 'orders',
        element: (
          <RequirePermission permission="order:read">
            <OrdersPage />
          </RequirePermission>
        ),
      },
      {
        path: 'orders/new',
        element: (
          <RequirePermission permission="order:write">
            <NewOrderPage />
          </RequirePermission>
        ),
      },
      {
        path: 'orders/:id',
        element: (
          <RequirePermission permission="order:read">
            <OrderDetailPage />
          </RequirePermission>
        ),
      },
      {
        path: 'tasks',
        element: (
          <RequirePermission permission="fulfillment:handle">
            <TasksPage />
          </RequirePermission>
        ),
      },
      {
        path: 'subscriptions',
        element: (
          <RequirePermission anyOf={['customer:read', 'subscription:read']}>
            <SubscriptionsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'subscriptions/:id',
        element: (
          <RequirePermission anyOf={['customer:read', 'subscription:read']}>
            <SubscriptionDetailPage />
          </RequirePermission>
        ),
      },
      { path: 'catalog', element: <CatalogPage /> },
      {
        path: 'settings',
        element: (
          <RequirePermission permission="settings:write">
            <SettingsPage />
          </RequirePermission>
        ),
      },
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
