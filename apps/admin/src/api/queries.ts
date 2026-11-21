import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from './client';

/** 常用下拉选项，多个页面共用同一份缓存 */
export const queryKeys = {
  roles: ['roles'] as const,
  teams: ['teams'] as const,
  permissions: ['permissions'] as const,
  users: (q?: object) => (q ? (['users', q] as const) : (['users'] as const)),
  auditLogs: (q: object) => ['audit-logs', q] as const,
};

export function useRoles(enabled = true) {
  return useQuery({
    queryKey: queryKeys.roles,
    queryFn: () => unwrap(api.GET('/api/roles')),
    enabled,
  });
}

export function useTeams(enabled = true) {
  return useQuery({
    queryKey: queryKeys.teams,
    queryFn: () => unwrap(api.GET('/api/teams')),
    enabled,
  });
}

export function usePermissionCatalog() {
  return useQuery({
    queryKey: queryKeys.permissions,
    queryFn: () => unwrap(api.GET('/api/permissions')),
    staleTime: Infinity,
  });
}

/** 在职员工下拉选项（选负责人、转交任务） */
export function useStaffOptions() {
  return useQuery({
    queryKey: ['staff-options'],
    queryFn: () => unwrap(api.GET('/api/staff/options')),
    staleTime: 60_000,
  });
}

export function useBusinessSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => unwrap(api.GET('/api/settings')),
    staleTime: 60_000,
  });
}

export function usePlans() {
  return useQuery({ queryKey: ['plans'], queryFn: () => unwrap(api.GET('/api/plans')) });
}

export function useProducts(activeOnly = false) {
  return useQuery({
    queryKey: ['products', { activeOnly }],
    queryFn: () => unwrap(api.GET('/api/products', { params: { query: { activeOnly } } })),
  });
}

/** 付款资源（充值员完成任务时选择） */
export function useResources(enabled = true) {
  return useQuery({
    queryKey: ['resources'],
    queryFn: () => unwrap(api.GET('/api/resources')),
    enabled,
  });
}

/** 代理下拉选项（录客户、录订单、设置上级时选择） */
export function useAgentOptions(enabled = true) {
  return useQuery({
    queryKey: ['agent-options'],
    queryFn: () => unwrap(api.GET('/api/agents/options')),
    staleTime: 60_000,
    enabled,
  });
}

/** 渠道列表（录客户时选、客户列表筛选），所有员工可看 */
export function useChannels() {
  return useQuery({
    queryKey: ['channels'],
    queryFn: () => unwrap(api.GET('/api/channels')),
    staleTime: 60_000,
  });
}
