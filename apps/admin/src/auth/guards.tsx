import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Button, Result, Spin } from 'antd';
import { errorMessage } from '../api/errors';
import { useAuth } from './AuthProvider';

function FullPageSpin() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
      <Spin size="large" />
    </div>
  );
}

/** 需要登录；还没改初始密码的员工先去改密码，角色要求两步验证但还没开的先去设置 */
export function RequireAuth({
  children,
  allowPendingPassword = false,
  allowPendingTotp = false,
}: {
  children: ReactNode;
  allowPendingPassword?: boolean;
  allowPendingTotp?: boolean;
}) {
  const { profile, loading, error, reload } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpin />;
  if (error && !profile) {
    return (
      <Result
        status="warning"
        title="暂时无法获取登录信息"
        subTitle={errorMessage(error)}
        extra={<Button onClick={() => void reload()}>重试</Button>}
      />
    );
  }
  if (!profile) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (profile.mustChangePassword && !allowPendingPassword) {
    return <Navigate to="/change-password" replace />;
  }
  if (profile.mustSetupTotp && !profile.mustChangePassword && !allowPendingTotp) {
    return <Navigate to="/setup-2fa" replace />;
  }
  return <>{children}</>;
}

/** 页面级权限：没有权限时显示 403，而不是空白页 */
export function RequirePermission({
  permission,
  anyOf,
  children,
}: {
  permission?: string;
  /** 拥有其中任意一个权限即可 */
  anyOf?: string[];
  children: ReactNode;
}) {
  const { can } = useAuth();
  const allowed = (!permission || can(permission)) && (!anyOf || anyOf.some((p) => can(p)));
  if (!allowed) {
    return (
      <Result status="403" title="没有权限" subTitle="你没有访问这个页面的权限，请联系管理员。" />
    );
  }
  return <>{children}</>;
}
