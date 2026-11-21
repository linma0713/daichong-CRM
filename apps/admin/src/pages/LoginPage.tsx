import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { Alert, Button, Card, Form, Input, Space, Typography } from 'antd';
import { LockOutlined, SafetyOutlined, UserOutlined } from '@ant-design/icons';
import { ErrorCode } from '@crm/shared';
import { ApiError, errorMessage } from '../api/errors';
import { useAuth, type Profile } from '../auth/AuthProvider';
import { TotpInput } from '../components/totp';

interface LoginForm {
  username: string;
  password: string;
}

/** 登录后去哪：先改初始密码，再按角色要求设置两步验证，最后回到原来要去的页面 */
export function landingPath(user: Profile, from: string): string {
  if (user.mustChangePassword) return '/change-password';
  if (user.mustSetupTotp) return '/setup-2fa';
  return from;
}

export function LoginPage() {
  const { profile, login, loginTotp } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 开了两步验证：第一步密码对了以后拿到的 challenge */
  const [challenge, setChallenge] = useState<string | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [recovery, setRecovery] = useState('');
  const [otpKey, setOtpKey] = useState(0);

  const from = (location.state as { from?: string } | null)?.from ?? '/';
  if (profile) return <Navigate to={landingPath(profile, from)} replace />;

  const onFinish = async (values: LoginForm) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await login(values.username.trim(), values.password);
      if (res.totpRequired) setChallenge(res.challenge);
      else navigate(landingPath(res.user, from), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const submitCode = async (code: string) => {
    if (!challenge) return;
    setSubmitting(true);
    setError(null);
    try {
      const user = await loginTotp(challenge, code);
      navigate(landingPath(user, from), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setOtpKey((k) => k + 1);
      // 验证过期或者输错太多被锁了，回到输密码那一步
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === ErrorCode.TOTP_CHALLENGE_EXPIRED || code === ErrorCode.ACCOUNT_LOCKED) {
        setChallenge(null);
        setUseRecovery(false);
        setRecovery('');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const backToPassword = () => {
    setChallenge(null);
    setError(null);
    setUseRecovery(false);
    setRecovery('');
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        background: 'linear-gradient(160deg, #eef4ff 0%, #f5f6f8 60%)',
      }}
    >
      <Card style={{ width: '100%', maxWidth: 380 }}>
        <Typography.Title level={3} style={{ textAlign: 'center', marginBottom: 4 }}>
          代充 CRM
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          {challenge ? '两步验证' : '内部管理后台，员工账号由管理员开通'}
        </Typography.Paragraph>
        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
        {!challenge ? (
          <Form<LoginForm> layout="vertical" onFinish={onFinish} requiredMark={false} size="large">
            <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
              <Input
                prefix={<UserOutlined />}
                placeholder="用户名"
                autoComplete="username"
                autoFocus
              />
            </Form.Item>
            <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password
                prefix={<LockOutlined />}
                placeholder="密码"
                autoComplete="current-password"
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={submitting}>
              登录
            </Button>
          </Form>
        ) : (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {!useRecovery ? (
              <>
                <Typography.Text>
                  <SafetyOutlined /> 打开手机上的验证器，输入「代充CRM」显示的 6 位数字
                </Typography.Text>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <TotpInput
                    key={otpKey}
                    disabled={submitting}
                    onComplete={(code) => void submitCode(code)}
                  />
                </div>
              </>
            ) : (
              <>
                <Typography.Text>输入一个没用过的恢复码（形如 abcd-2345）</Typography.Text>
                <Input
                  size="large"
                  value={recovery}
                  onChange={(e) => setRecovery(e.target.value)}
                  placeholder="恢复码"
                  autoFocus
                  onPressEnter={() => recovery.trim() && void submitCode(recovery.trim())}
                />
                <Button
                  type="primary"
                  block
                  size="large"
                  loading={submitting}
                  disabled={!recovery.trim()}
                  onClick={() => void submitCode(recovery.trim())}
                >
                  登录
                </Button>
              </>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Button type="link" style={{ padding: 0 }} onClick={backToPassword}>
                返回
              </Button>
              <Button
                type="link"
                style={{ padding: 0 }}
                onClick={() => {
                  setUseRecovery((v) => !v);
                  setError(null);
                }}
              >
                {useRecovery ? '用验证码登录' : '手机不在身边？用恢复码'}
              </Button>
            </div>
          </Space>
        )}
      </Card>
    </div>
  );
}
