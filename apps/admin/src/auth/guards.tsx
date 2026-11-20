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

/** 需要登录；还没改初始密码的员工先去改密码 */
export function RequireAuth({
  children,
  allowPendingPassword = false,
}: {
  children: ReactNode;
  allowPendingPassword?: boolean;
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
  return <>{children}</>;
}

/** 页面级权限：没有权限时显示 403，而不是空白页 */
export function RequirePermission({
  permission,
  children,
}: {
  permission: string;
  children: ReactNode;
}) {
  const { can } = useAuth();
  if (!can(permission)) {
    return (
      <Result status="403" title="没有权限" subTitle="你没有访问这个页面的权限，请联系管理员。" />
    );
  }
  return <>{children}</>;
}
