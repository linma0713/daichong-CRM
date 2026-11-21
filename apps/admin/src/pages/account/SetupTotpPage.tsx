import { Navigate, useNavigate } from 'react-router';
import { Alert, Button, Card, Typography } from 'antd';
import { useAuth } from '../../auth/AuthProvider';
import { TotpSetupFlow } from '../../components/totp';

/** 角色要求两步验证、还没开的员工登录后先来这里设置，设置完才能用后台 */
export function SetupTotpPage() {
  const { profile, reload, logout } = useAuth();
  const navigate = useNavigate();
  if (profile && !profile.mustSetupTotp) return <Navigate to="/" replace />;
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <Card style={{ width: '100%', maxWidth: 620 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          请先开启两步验证
        </Typography.Title>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 20 }}
          message={`${profile?.displayName ?? ''}，管理员要求你的岗位开启两步验证：以后登录除了密码，还要输入手机验证器里的 6 位数字，密码泄露了别人也登不进来。`}
        />
        <TotpSetupFlow
          username={profile?.username ?? ''}
          onDone={async () => {
            await reload();
            navigate('/', { replace: true });
          }}
        />
        <Button
          type="link"
          block
          style={{ marginTop: 8 }}
          onClick={async () => {
            await logout();
            navigate('/login', { replace: true });
          }}
        >
          换个账号登录
        </Button>
      </Card>
    </div>
  );
}
