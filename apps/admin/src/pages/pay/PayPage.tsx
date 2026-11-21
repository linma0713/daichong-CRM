import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { Alert, Button, Result, Spin, Typography } from 'antd';
import { CheckCircleFilled, ClockCircleOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatCents } from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { ApiError, errorMessage } from '../../api/errors';

type PayInfo = Schemas['PublicPayInfoDto'];

/** 剩余时间 mm:ss；超过 1 小时显示 h 小时 m 分 */
function leftLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 客户付款页（不用登录）：/pay/<链接里的随机串>。
 * 模拟通道直接在这里点「模拟付款成功」；真实通道跳到支付平台付款，回来后自动刷新结果。
 */
export function PayPage() {
  const { token = '' } = useParams();
  const queryClient = useQueryClient();
  const key = ['pay', token];
  const info = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET('/api/pay/{token}', { params: { path: { token } } })),
    meta: { silent: true },
    retry: false,
    // 等付款时每 5 秒看一次（真实通道付完款回到这个页面就能看到结果）
    refetchInterval: (q) => (q.state.data?.status === 'PENDING' ? 5_000 : false),
  });
  const pay = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/api/pay/{token}/mock-pay', { params: { path: { token } } })),
    meta: { silent: true },
    onSuccess: (data) => queryClient.setQueryData(key, data),
    onError: () => void queryClient.invalidateQueries({ queryKey: key }),
  });

  const d = info.data;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (d?.status !== 'PENDING') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [d?.status]);
  const left = d ? new Date(d.expiresAt).getTime() - now : 0;
  // 倒计时到了，重新查一次状态（后端按已过期返回）
  const timeUp = d?.status === 'PENDING' && left <= 0;
  const { refetch } = info;
  useEffect(() => {
    if (timeUp) void refetch();
  }, [timeUp, refetch]);

  const title = d?.shopName ? `${d.shopName} · 订单付款` : '订单付款';
  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <div className="pay-page">
      <div className="pay-card">
        <div className="pay-shop">{d?.shopName || '订单付款'}</div>
        {info.isLoading ? (
          <Spin style={{ display: 'block', margin: '48px auto' }} />
        ) : !d ? (
          <Result
            status="warning"
            title={
              info.error instanceof ApiError && info.error.status === 404
                ? '付款链接不存在'
                : '暂时打不开付款页'
            }
            subTitle={
              info.error instanceof ApiError && info.error.status === 404
                ? '请检查链接是否完整，或联系客服重新获取'
                : '请稍后刷新重试'
            }
          />
        ) : (
          <PayBody info={d} left={left} pay={pay} />
        )}
      </div>
      <Typography.Text type="secondary" className="pay-foot">
        付款遇到问题请直接联系为您服务的客服
      </Typography.Text>
    </div>
  );
}

function PayBody({
  info: d,
  left,
  pay,
}: {
  info: PayInfo;
  left: number;
  pay: { mutate: () => void; isPending: boolean; error: unknown };
}) {
  const amount = (
    <div className="pay-amount-block">
      <div className="pay-amount">{formatCents(d.amountCents)}</div>
      <div className="pay-order">
        订单 {d.orderCode} · {d.productName}
      </div>
    </div>
  );

  if (d.status === 'PAID') {
    return (
      <>
        {amount}
        <Result
          icon={<CheckCircleFilled style={{ color: '#52c41a' }} />}
          title="付款成功"
          subTitle="我们已经收到您的付款，马上为您开通。可以关闭这个页面了。"
        />
      </>
    );
  }
  if (d.status !== 'PENDING') {
    return (
      <>
        {amount}
        <Result
          status="info"
          icon={<ClockCircleOutlined />}
          title={d.status === 'EXPIRED' ? '链接已过期' : '链接已失效'}
          subTitle="请联系客服重新获取付款链接"
        />
      </>
    );
  }

  return (
    <>
      {amount}
      <div className="pay-left">
        请在 <strong>{leftLabel(left)}</strong> 内完成付款
      </div>
      {d.mock && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16, textAlign: 'left' }}
          message="测试通道"
          description="这是测试用的付款页，点下面的按钮就算付款成功，不会真的扣钱。"
        />
      )}
      {pay.error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16, textAlign: 'left' }}
          message={errorMessage(pay.error)}
        />
      ) : null}
      {d.mock ? (
        <Button type="primary" size="large" block loading={pay.isPending} onClick={pay.mutate}>
          模拟付款成功
        </Button>
      ) : d.payUrl ? (
        <Button type="primary" size="large" block href={d.payUrl}>
          去付款
        </Button>
      ) : (
        <Alert type="info" showIcon message="付款通道暂时不可用，请联系客服" />
      )}
    </>
  );
}
