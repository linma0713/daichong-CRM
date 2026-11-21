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
import { InventoryPage } from './pages/inventory/InventoryPage';
import { FinancePage } from './pages/finance/FinancePage';
import { AnalyticsPage } from './pages/analytics/AnalyticsPage';
import { TicketsPage } from './pages/aftersales/TicketsPage';
import { TicketDetailPage } from './pages/aftersales/TicketDetailPage';
import { RefundsPage } from './pages/aftersales/RefundsPage';
import { AgentsPage } from './pages/agents/AgentsPage';
import { AgentDetailPage } from './pages/agents/AgentDetailPage';
import { CommissionsPage } from './pages/commissions/CommissionsPage';
import { StatementDetailPage } from './pages/commissions/StatementDetailPage';
import { AGENT_VIEW_PERMISSIONS } from './components/business';

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
      {
        path: 'tickets',
        element: (
          <RequirePermission anyOf={['ticket:create', 'ticket:handle']}>
            <TicketsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'tickets/:id',
        element: (
          <RequirePermission anyOf={['ticket:create', 'ticket:handle']}>
            <TicketDetailPage />
          </RequirePermission>
        ),
      },
      {
        path: 'refunds',
        element: (
          <RequirePermission anyOf={['refund:approve', 'ticket:handle', 'finance:read']}>
            <RefundsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'agents',
        element: (
          <RequirePermission anyOf={AGENT_VIEW_PERMISSIONS}>
            <AgentsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'agents/:id',
        element: (
          <RequirePermission anyOf={AGENT_VIEW_PERMISSIONS}>
            <AgentDetailPage />
          </RequirePermission>
        ),
      },
      {
        path: 'commissions',
        element: (
          <RequirePermission anyOf={[...AGENT_VIEW_PERMISSIONS, 'finance:read']}>
            <CommissionsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'commissions/statements/:id',
        element: (
          <RequirePermission anyOf={[...AGENT_VIEW_PERMISSIONS, 'finance:read']}>
            <StatementDetailPage />
          </RequirePermission>
        ),
      },
      { path: 'catalog', element: <CatalogPage /> },
      {
        path: 'inventory',
        element: (
          <RequirePermission permission="inventory:read">
            <InventoryPage />
          </RequirePermission>
        ),
      },
      {
        path: 'finance',
        element: (
          <RequirePermission permission="finance:read">
            <FinancePage />
          </RequirePermission>
        ),
      },
      {
        path: 'analytics',
        element: (
          <RequirePermission permission="report:read">
            <AnalyticsPage />
          </RequirePermission>
        ),
      },
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
