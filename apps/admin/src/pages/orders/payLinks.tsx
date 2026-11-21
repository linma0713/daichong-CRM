import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Form,
  InputNumber,
  Modal,
  QRCode,
  Result,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { CopyOutlined, LinkOutlined, SyncOutlined } from '@ant-design/icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  FULFILLMENT_TYPE_LABELS,
  PAY_CHANNEL_LABELS,
  PAYMENT_LINK_STATUS_LABELS,
  formatCents,
  payLinkMessage,
  termLabel,
  type PaymentLinkStatus,
} from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { useBusinessSettings } from '../../api/queries';
import { useAuth } from '../../auth/AuthProvider';
import { Money } from '../../components/business';
import { formatTime } from '../../components/format';
import { copyText } from '../../components/scripts';

type Order = Schemas['OrderDetailDto'];
type PayLink = Schemas['PaymentLinkDto'];

const LINK_STATUS_COLORS: Record<PaymentLinkStatus, string> = {
  PENDING: 'processing',
  PAID: 'success',
  EXPIRED: 'default',
  CLOSED: 'default',
};
export function PayLinkStatusTag({ status }: { status: PaymentLinkStatus }) {
  return <Tag color={LINK_STATUS_COLORS[status]}>{PAYMENT_LINK_STATUS_LABELS[status]}</Tag>;
}

/** 发给客户的完整链接：设置了 APP_PUBLIC_URL 用它，否则用现在打开后台的地址 */
export const linkUrl = (l: PayLink) => l.payUrl ?? `${window.location.origin}${l.payPath}`;

/** 本机、局域网地址：客户在外网打不开 */
const isPrivateHost = (host: string) =>
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)/.test(host);

const productOf = (o: Order) =>
  `${o.planName} ${termLabel(o.termMonths)}（${FULFILLMENT_TYPE_LABELS[o.fulfillmentType]}）`;

/**
 * 在线收款：生成链接 → 二维码 / 复制链接 / 复制付款话术 → 等客户付款（每 3 秒查一次）。
 * 已经有等付款的链接就直接显示它，可以重新生成（旧的作废）。
 */
export function PayLinkModal({
  order,
  open,
  onClose,
  onChanged,
}: {
  order: Order;
  open: boolean;
  onClose: () => void;
  /** 生成、付款后刷新订单 */
  onChanged: () => void;
}) {
  return (
    <Modal
      open={open}
      title={`在线收款 · 订单 ${order.code}`}
      footer={null}
      onCancel={onClose}
      width={480}
      destroyOnHidden
    >
      <PayLinkBody order={order} onClose={onClose} onChanged={onChanged} />
    </Modal>
  );
}

function PayLinkBody({
  order: o,
  onClose,
  onChanged,
}: {
  order: Order;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { message } = App.useApp();
  const settings = useBusinessSettings();
  const remaining = o.amountCents - o.paidCents;
  // 打开时取一次：已经有等付款的链接就直接显示，之后由轮询更新
  const [link, setLink] = useState<PayLink | null>(
    () => o.paymentLinks.find((l) => l.status === 'PENDING') ?? null,
  );
  const [regenerate, setRegenerate] = useState(false);
  const [form] = Form.useForm<{ yuan: number }>();

  const create = useMutation({
    mutationFn: (amountCents: number) =>
      unwrap(
        api.POST('/api/orders/{id}/payment-links', {
          params: { path: { id: o.id } },
          body: { amountCents },
        }),
      ),
    onSuccess: (l) => {
      setLink(l);
      setRegenerate(false);
      onChanged();
    },
  });

  const status = useQuery({
    queryKey: ['payment-link', link?.id],
    queryFn: () =>
      unwrap(api.GET('/api/payment-links/{id}', { params: { path: { id: link!.id } } })),
    enabled: !!link && link.status === 'PENDING',
    refetchInterval: 3_000,
    refetchIntervalInBackground: false,
  });
  useEffect(() => {
    if (status.data && link && status.data.status !== link.status) {
      setLink(status.data);
      onChanged();
    }
  }, [status.data, link, onChanged]);

  const copy = async (text: string, what: string) => {
    if (await copyText(text)) message.success(`已复制${what}`);
    else message.error('复制失败，请手动选中复制');
  };

  const showForm = !link || regenerate;
  const url = link ? linkUrl(link) : '';
  const text = link
    ? payLinkMessage({
        orderCode: o.code,
        productName: productOf(o),
        amountCents: link.amountCents,
        url,
        minutes: settings.data?.payLinkMinutes ?? 30,
      })
    : '';
  const mock = (link?.channel ?? settings.data?.onlinePayChannel) === 'mock';

  return (
    <>
      {mock && (link?.status ?? 'PENDING') === 'PENDING' && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="现在用的是模拟通道"
          description="客户打开链接点一下就算付款成功，不会真的扣钱。只用来测试流程，不要发给真实客户。"
        />
      )}
      {showForm ? (
        <Form
          form={form}
          layout="vertical"
          initialValues={{ yuan: remaining / 100 }}
          onFinish={(v) => create.mutate(Math.round(v.yuan * 100))}
          style={{ marginTop: 8 }}
        >
          <Form.Item
            name="yuan"
            label="收款金额（元）"
            rules={[{ required: true, message: '请填写金额' }]}
            extra={`订单还差 ${formatCents(remaining)}；只收定金或分次收可以改小。链接 ${
              settings.data?.payLinkMinutes ?? 30
            } 分钟内有效`}
          >
            <InputNumber
              min={0.01}
              max={remaining / 100}
              precision={2}
              prefix="¥"
              style={{ width: 200 }}
            />
          </Form.Item>
          {regenerate && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message={`生成新链接后，之前的链接 ${link?.code} 会失效`}
            />
          )}
          <Space>
            <Button type="primary" htmlType="submit" loading={create.isPending}>
              生成收款链接
            </Button>
            {regenerate && <Button onClick={() => setRegenerate(false)}>不重新生成</Button>}
          </Space>
        </Form>
      ) : link!.status === 'PAID' ? (
        <Result
          status={link!.anomaly ? 'warning' : 'success'}
          title={`客户已付款 ${formatCents(link!.amountCents)}`}
          subTitle={
            link!.anomaly
              ? `没有自动记账：${link!.anomaly}`
              : // 订单数据刷新回来之前不知道收没收齐，先只说已确认
                o.paymentLinks.find((l) => l.id === link!.id)?.status !== 'PAID'
                ? '已自动确认收款'
                : o.status === 'PENDING_PAYMENT'
                  ? `已自动确认收款，订单还差 ${formatCents(remaining)}`
                  : '已自动确认收款，开通任务已派出'
          }
          extra={
            <Button type="primary" onClick={onClose}>
              好的
            </Button>
          }
        />
      ) : link!.status !== 'PENDING' ? (
        <Result
          status="info"
          title={`链接${PAYMENT_LINK_STATUS_LABELS[link!.status]}`}
          extra={
            <Button type="primary" onClick={() => setRegenerate(true)}>
              重新生成
            </Button>
          }
        />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div className="pay-qr">
            <QRCode value={url} size={180} bordered={false} />
            <div>
              <Typography.Text type="secondary">{link!.code} · 应付</Typography.Text>
              <div style={{ fontSize: 24, fontWeight: 600 }}>{formatCents(link!.amountCents)}</div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatTime(link!.expiresAt)} 前有效
              </Typography.Text>
              <div style={{ marginTop: 8 }}>
                <Tag icon={<SyncOutlined spin />} color="processing">
                  等待客户付款…
                </Tag>
              </div>
            </div>
          </div>
          <Typography.Paragraph
            className="pay-url"
            ellipsis={{ rows: 2 }}
            style={{ margin: 0 }}
            title={url}
          >
            <LinkOutlined /> {url}
          </Typography.Paragraph>
          {!link!.payUrl && isPrivateHost(window.location.hostname) && (
            <Alert
              type="info"
              showIcon
              message="这是本机 / 局域网地址，客户在外网打不开"
              description="上线后在 .env 里设置 APP_PUBLIC_URL（后台的公网地址），链接会自动用它。"
            />
          )}
          <Space wrap>
            <Button type="primary" icon={<CopyOutlined />} onClick={() => copy(text, '付款话术')}>
              复制付款话术
            </Button>
            <Button icon={<CopyOutlined />} onClick={() => copy(url, '链接')}>
              只复制链接
            </Button>
            <Button onClick={() => setRegenerate(true)}>重新生成</Button>
          </Space>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
            客户扫码或打开链接付款，付款后这里会自动变成「已付款」，系统自动记收款、派开通任务，不用再手动确认。
          </Typography.Paragraph>
        </Space>
      )}
    </>
  );
}

/** 订单详情里的收款链接列表 */
export function PayLinksTable({ order: o, onChanged }: { order: Order; onChanged: () => void }) {
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const canManage = can('order:write') || can('payment:confirm');
  const close = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/api/payment-links/{id}/close', { params: { path: { id } } })),
    onSuccess: () => {
      message.success('链接已关闭');
      onChanged();
    },
  });
  const askClose = (l: PayLink) =>
    modal.confirm({
      title: `关闭收款链接 ${l.code}？`,
      content: '关闭后客户就不能再用这条链接付款。',
      okText: '关闭链接',
      okButtonProps: { danger: true },
      cancelText: '不关闭',
      onOk: () => close.mutateAsync(l.id),
    });

  return (
    <Table<PayLink>
      rowKey="id"
      size="small"
      pagination={false}
      dataSource={o.paymentLinks}
      scroll={{ x: 'max-content' }}
      columns={[
        { title: '编号', dataIndex: 'code', width: 90 },
        {
          title: '金额',
          key: 'amount',
          render: (_, l) => <Money cents={l.amountCents} />,
        },
        {
          title: '状态',
          key: 'status',
          render: (_, l) => (
            <Space direction="vertical" size={0}>
              <Space size={4}>
                <PayLinkStatusTag status={l.status} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {PAY_CHANNEL_LABELS[l.channel] ?? l.channel}
                </Typography.Text>
              </Space>
              {l.anomaly && (
                <Typography.Text type="danger" style={{ fontSize: 12 }}>
                  没有自动记账：{l.anomaly}
                </Typography.Text>
              )}
            </Space>
          ),
        },
        {
          title: '时间',
          key: 'time',
          render: (_, l) => (
            <Typography.Text style={{ fontSize: 12 }}>
              {l.status === 'PAID'
                ? `付款 ${formatTime(l.paidAt)}`
                : l.status === 'CLOSED'
                  ? `关闭 ${formatTime(l.closedAt)}`
                  : `${formatTime(l.expiresAt)} 前有效`}
            </Typography.Text>
          ),
        },
        {
          title: '生成人',
          key: 'by',
          responsive: ['md'],
          render: (_, l) => (
            <Typography.Text style={{ fontSize: 12 }}>
              {l.createdBy.displayName} · {formatTime(l.createdAt)}
            </Typography.Text>
          ),
        },
        {
          title: '',
          key: 'actions',
          render: (_, l) =>
            l.status === 'PENDING' && (
              <Space size={0}>
                <Button
                  type="link"
                  size="small"
                  onClick={async () => {
                    if (await copyText(linkUrl(l))) message.success('已复制链接');
                  }}
                >
                  复制链接
                </Button>
                {canManage && (
                  <Button type="link" size="small" danger onClick={() => askClose(l)}>
                    关闭
                  </Button>
                )}
              </Space>
            ),
        },
      ]}
    />
  );
}

/** 收款记录里的「在线收款」标记 */
export function OnlinePayTag({ channel }: { channel: string | null }) {
  if (!channel) return null;
  return (
    <Tag color="blue" bordered={false} style={{ marginInlineEnd: 0 }}>
      在线收款 · {PAY_CHANNEL_LABELS[channel] ?? channel}
    </Tag>
  );
}
