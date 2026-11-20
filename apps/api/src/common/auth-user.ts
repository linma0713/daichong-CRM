import type { DataScope } from '@crm/shared';

/** 当前登录员工，由登录令牌解析得到，挂在 request.user 上 */
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  teamId: string | null;
  sessionId: string;
  roles: { id: string; code: string; name: string }[];
  permissions: string[];
  dataScope: DataScope;
  mustChangePassword: boolean;
}
