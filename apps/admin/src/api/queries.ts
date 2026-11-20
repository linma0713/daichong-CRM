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
