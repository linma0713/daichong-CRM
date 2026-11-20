import { useNavigate } from 'react-router';
import { Alert, App, Button, Card, Form, Input, Typography } from 'antd';
import { useMutation } from '@tanstack/react-query';
import { PASSWORD_RULE } from '@crm/shared';
import { api, unwrap } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

interface PasswordForm {
  oldPassword: string;
  newPassword: string;
  confirm: string;
}

/** 修改密码。forced=true 时是首次登录强制改密码的独立页面 */
export function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const { message } = App.useApp();
  const { reload, logout, profile } = useAuth();
  const navigate = useNavigate();
  const [form] = Form.useForm<PasswordForm>();

  const change = useMutation({
    mutationFn: (v: PasswordForm) =>
      unwrap(
        api.POST('/api/auth/change-password', {
          body: { oldPassword: v.oldPassword, newPassword: v.newPassword },
        }),
      ),
    onSuccess: async () => {
      message.success('密码已修改，其他设备上的登录已退出');
      form.resetFields();
      await reload();
      if (forced) navigate('/', { replace: true });
    },
  });

  const body = (
    <Form<PasswordForm>
      form={form}
      layout="vertical"
      onFinish={(v) => change.mutate(v)}
      style={{ maxWidth: 400 }}
    >
      <Form.Item
        name="oldPassword"
        label={forced ? '初始密码' : '原密码'}
        rules={[{ required: true, message: '请输入原密码' }]}
      >
        <Input.Password autoComplete="current-password" />
      </Form.Item>
      <Form.Item
        name="newPassword"
        label="新密码"
        extra={PASSWORD_RULE.message}
        rules={[
          { required: true, message: '请输入新密码' },
          { pattern: PASSWORD_RULE.pattern, message: PASSWORD_RULE.message },
        ]}
      >
        <Input.Password autoComplete="new-password" />
      </Form.Item>
      <Form.Item
        name="confirm"
        label="再次输入新密码"
        dependencies={['newPassword']}
        rules={[
          { required: true, message: '请再次输入新密码' },
          ({ getFieldValue }) => ({
            validator: (_, value) =>
              !value || value === getFieldValue('newPassword')
                ? Promise.resolve()
                : Promise.reject(new Error('两次输入的密码不一致')),
          }),
        ]}
      >
        <Input.Password autoComplete="new-password" />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={change.isPending} block={forced}>
        确认修改
      </Button>
    </Form>
  );

  if (!forced) {
    return (
      <Card title="修改密码" style={{ maxWidth: 520 }}>
        {body}
      </Card>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <Card style={{ width: '100%', maxWidth: 420 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          请先修改初始密码
        </Typography.Title>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={`${profile?.displayName ?? ''}，为了账号安全，首次登录或密码被重置后需要设置自己的密码。`}
        />
        {body}
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
