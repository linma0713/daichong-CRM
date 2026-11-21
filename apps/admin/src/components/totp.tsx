import { useEffect, useState } from 'react';
import { Alert, App, Button, Input, QRCode, Space, Spin, Steps, Typography } from 'antd';
import { CopyOutlined, DownloadOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import { api, unwrap } from '../api/client';

/** 恢复码：只显示这一次，提供复制和下载 */
export function RecoveryCodes({ codes, username }: { codes: string[]; username?: string }) {
  const { message } = App.useApp();
  const text = codes.join('\n');
  const download = () => {
    const content = `代充 CRM 两步验证恢复码${username ? `（${username}）` : ''}\n每个只能用一次，手机丢了用它登录。\n\n${text}\n`;
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'crm-recovery-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <div>
      <Alert
        type="warning"
        showIcon
        message="把这些恢复码抄下来或下载保存，只显示这一次"
        description="手机丢了、换了，可以在登录时用其中一个代替验证码，每个只能用一次。"
        style={{ marginBottom: 12 }}
      />
      <div className="recovery-codes" data-testid="recovery-codes">
        {codes.map((c) => (
          <code key={c}>{c}</code>
        ))}
      </div>
      <Space style={{ marginTop: 12 }}>
        <Button
          icon={<CopyOutlined />}
          onClick={() =>
            void navigator.clipboard
              ?.writeText(text)
              .then(() => message.success('已复制'))
              .catch(() => message.error('复制失败，请手动抄写'))
          }
        >
          复制全部
        </Button>
        <Button icon={<DownloadOutlined />} onClick={download}>
          下载保存
        </Button>
      </Space>
    </div>
  );
}

/** 6 位验证码输入框 */
export function TotpInput({
  onComplete,
  disabled,
}: {
  onComplete: (code: string) => void;
  disabled?: boolean;
}) {
  return (
    <Input.OTP
      length={6}
      size="large"
      disabled={disabled}
      formatter={(v) => v.replace(/\D/g, '')}
      onChange={(v) => v.length === 6 && onComplete(v)}
      autoFocus
    />
  );
}

/**
 * 开启两步验证：扫码 → 输验证码 → 保存恢复码。
 * 「账号安全」弹窗和强制设置页共用。
 */
export function TotpSetupFlow({ username, onDone }: { username: string; onDone: () => void }) {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const setup = useMutation({ mutationFn: () => unwrap(api.POST('/api/auth/totp/setup')) });
  const enable = useMutation({
    mutationFn: (code: string) => unwrap(api.POST('/api/auth/totp/enable', { body: { code } })),
    onSuccess: (r) => setCodes(r.recoveryCodes),
    // 输错了清空输入框，方便重输
    onError: () => setInputKey((k) => k + 1),
  });
  const { mutate: start } = setup;
  useEffect(() => start(), [start]);

  const step = codes ? 2 : 0;
  return (
    <div>
      <Steps
        size="small"
        current={step}
        style={{ marginBottom: 20 }}
        items={[{ title: '扫码添加' }, { title: '输入验证码' }, { title: '保存恢复码' }]}
      />
      {codes ? (
        <>
          <RecoveryCodes codes={codes} username={username} />
          <Button type="primary" block style={{ marginTop: 16 }} onClick={onDone}>
            我已保存好，完成
          </Button>
        </>
      ) : setup.isPending || !setup.data ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          {setup.isError ? <Button onClick={() => start()}>重试</Button> : <Spin />}
        </div>
      ) : (
        <div className="totp-setup">
          <div className="totp-setup-qr">
            <QRCode value={setup.data.otpauthUrl} size={176} bordered={false} />
          </div>
          <div className="totp-setup-text">
            <Typography.Paragraph style={{ marginBottom: 8 }}>
              1. 打开手机上的验证器，扫左边的二维码。微信里搜小程序「腾讯身份验证器」，或者用 Google
              Authenticator、Microsoft Authenticator 都可以。
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
              扫不了就手动输入密钥（空格不用输）：
              <br />
              <Typography.Text code copyable={{ text: setup.data.secret }} style={{ fontSize: 12 }}>
                {setup.data.secret.replace(/(.{4})(?=.)/g, '$1 ')}
              </Typography.Text>
            </Typography.Paragraph>
            <Typography.Paragraph style={{ marginBottom: 8 }}>
              2. 输入验证器里显示的 6 位数字：
            </Typography.Paragraph>
            <TotpInput
              key={inputKey}
              disabled={enable.isPending}
              onComplete={(code) => enable.mutate(code)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
