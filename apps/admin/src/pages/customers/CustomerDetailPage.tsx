import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Result,
  Select,
  Space,
  Spin,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CUSTOMER_SOURCES, FOLLOW_UP_KINDS, lostReasonLabel, type FollowUpKind } from '@crm/shared';
import { api, unwrap } from '../../api/client';
import { useStaffOptions } from '../../api/queries';
import { useAuth } from '../../auth/AuthProvider';
import { AgentLink, CustomerStageTag, Money } from '../../components/business';
import { formatTime } from '../../components/format';
import { ScriptPicker, useSubscriptionVars } from '../../components/scripts';
import { OrderTable } from '../orders/OrdersPage';
import { SubscriptionTable } from '../subscriptions/SubscriptionsPage';
import { CustomerFormModal } from './CustomersPage';
import { LostReasonModal } from './modals';

const KIND = Object.fromEntries(FOLLOW_UP_KINDS.map((k) => [k.value, k]));
type ManualKind = Exclude<FollowUpKind, 'lost_reason'>;

const SOURCE_LABELS = Object.fromEntries(CUSTOMER_SOURCES.map((s) => [s.value, s.label]));

export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { can, profile } = useAuth();
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [losing, setLosing] = useState(false);
  const [followForm] = Form.useForm<{ content: string; kind: ManualKind }>();

  const customer = useQuery({
    queryKey: ['customer', id],
    queryFn: () => unwrap(api.GET('/api/customers/{id}', { params: { path: { id } } })),
  });
  const subs = useQuery({
    queryKey: ['subscriptions', { customerId: id, pageSize: 100 }],
    queryFn: () =>
      unwrap(
        api.GET('/api/subscriptions', { params: { query: { customerId: id, pageSize: 100 } } }),
      ),
    enabled: !!customer.data,
  });
  const orders = useQuery({
    queryKey: ['orders', { customerId: id, pageSize: 50 }],
    queryFn: () =>
      unwrap(api.GET('/api/orders', { params: { query: { customerId: id, pageSize: 50 } } })),
    enabled: !!customer.data && can('order:read'),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['customer', id] });
    void queryClient.invalidateQueries({ queryKey: ['customers'] });
  };
  const addFollowUp = useMutation({
    mutationFn: (v: { content: string; kind: ManualKind }) =>
      unwrap(
        api.POST('/api/customers/{id}/follow-ups', {
          params: { path: { id } },
          body: { content: v.content.trim(), kind: v.kind },
        }),
      ),
    onSuccess: () => {
      followForm.resetFields(['content']);
      refresh();
    },
  });
  // 话术变量取最近要到期的服务中订阅；都结束了取最后结束的那个
  const subItems = subs.data?.items ?? [];
  const mainSub =
    subItems
      .filter((s) => s.status === 'ACTIVE')
      .sort((a, b) => a.endAt.localeCompare(b.endAt))[0] ??
    [...subItems].sort((a, b) => b.endAt.localeCompare(a.endAt))[0];
  const scriptVars = useSubscriptionVars(mainSub, customer.data?.name ?? '');
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/customers/{id}', { params: { path: { id } } })),
    onSuccess: () => {
      message.success('已删除');
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      navigate('/customers', { replace: true });
    },
  });

  if (customer.isLoading) return <Spin style={{ display: 'block', margin: 48 }} />;
  if (!customer.data) return <Result status="404" title="客户不存在或你没有权限查看" />;
  const c = customer.data;
  const canWrite = can('customer:write');
  const subsByCode = new Map((subs.data?.items ?? []).map((s) => [s.id, s.code]));
  const lapsed = c.stage === 'DORMANT' || c.stage === 'CHURNED';

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space wrap>
            {c.name}
            <Typography.Text type="secondary">{c.code}</Typography.Text>
            <CustomerStageTag stage={c.stage} vip={c.vip} />
            {c.tags.map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
          </Space>
        }
        extra={
          <Space wrap>
            {can('order:write') && (
              <Button type="primary" onClick={() => navigate(`/orders/new?customerId=${c.id}`)}>
                录入订单
              </Button>
            )}
            {canWrite && (
              <ScriptPicker
                category={lapsed ? 'recall' : c.activeSubscriptionCount > 0 ? 'renewal' : 'quote'}
                vars={{ ...scriptVars, 客服: scriptVars.客服 ?? c.owner.displayName }}
                type="default"
                size="middle"
              />
            )}
            {canWrite && c.stage !== 'LEAD' && (lapsed || c.lostReason) && (
              <Button onClick={() => setLosing(true)}>流失原因</Button>
            )}
            {canWrite && <Button onClick={() => setEditing(true)}>编辑</Button>}
            {canWrite && profile?.dataScope !== 'SELF' && (
              <Button onClick={() => setTransferring(true)}>更换负责人</Button>
            )}
            {canWrite && (
              <Button
                danger
                onClick={() =>
                  modal.confirm({
                    title: `删除客户「${c.name}」？`,
                    content: '只能删除录错、没有任何订单的客户。',
                    okText: '删除',
                    okButtonProps: { danger: true },
                    onOk: () => remove.mutateAsync(),
                  })
                }
              >
                删除
              </Button>
            )}
          </Space>
        }
      >
        <Descriptions column={{ xs: 1, md: 3 }} size="small">
          <Descriptions.Item label="微信">{c.wechat ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Telegram">{c.telegram ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="手机">{c.phone ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="邮箱">{c.email ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="来源">
            {SOURCE_LABELS[c.source] ?? c.source}
            {c.referrer && (
              <Typography.Link
                style={{ marginLeft: 8 }}
                onClick={() => navigate(`/customers/${c.referrer!.id}`)}
              >
                推荐人 {c.referrer.name}
              </Typography.Link>
            )}
          </Descriptions.Item>
          {c.agent && (
            <Descriptions.Item label="代理">
              <AgentLink agent={c.agent} />
              <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                {formatTime(c.agentBoundAt)} 绑定
              </Typography.Text>
            </Descriptions.Item>
          )}
          <Descriptions.Item label="负责人">{c.owner.displayName}</Descriptions.Item>
          <Descriptions.Item label="录入时间">{formatTime(c.createdAt)}</Descriptions.Item>
          {c.remark && <Descriptions.Item label="备注">{c.remark}</Descriptions.Item>}
        </Descriptions>
        <Descriptions
          column={{ xs: 1, md: 3 }}
          size="small"
          style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed #f0f0f0' }}
        >
          <Descriptions.Item label="累计实付">
            <Money cents={c.netPaidCents} strong />
            <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
              {c.paidOrderCount} 单
            </Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="首次付款">{formatTime(c.firstPaidAt)}</Descriptions.Item>
          <Descriptions.Item label="最近付款">{formatTime(c.lastPaidAt)}</Descriptions.Item>
          <Descriptions.Item label="服务结束">
            {c.activeSubscriptionCount > 0 ? '服务中' : formatTime(c.serviceEndAt)}
          </Descriptions.Item>
          <Descriptions.Item label="上次联系">{formatTime(c.lastContactAt)}</Descriptions.Item>
          {c.lostReason && (
            <Descriptions.Item label="流失原因">
              <Typography.Text type="danger">{lostReasonLabel(c.lostReason)}</Typography.Text>
              {c.lostNote && <span style={{ marginLeft: 8 }}>{c.lostNote}</span>}
              <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                {formatTime(c.lostReasonAt).slice(0, 10)} 记录
              </Typography.Text>
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      <Card title={`订阅（服务中 ${c.activeSubscriptionCount} 个）`} size="small">
        <SubscriptionTable data={subs.data?.items} loading={subs.isFetching} hideCustomer />
      </Card>

      {can('order:read') && (
        <Card title="订单" size="small">
          <OrderTable data={orders.data?.items} loading={orders.isFetching} hideCustomer />
        </Card>
      )}

      <Card title="跟进记录" size="small">
        {canWrite && (
          <Form
            form={followForm}
            layout="inline"
            style={{ marginBottom: 16, rowGap: 8 }}
            initialValues={{ kind: lapsed ? 'recall' : 'note' }}
            onFinish={(v) => addFollowUp.mutate(v)}
          >
            <Form.Item name="kind">
              <Select
                style={{ width: 90 }}
                options={[
                  { value: 'note', label: '跟进' },
                  { value: 'recall', label: '召回' },
                ]}
              />
            </Form.Item>
            <Form.Item
              name="content"
              rules={[{ required: true, whitespace: true, message: '请输入跟进内容' }]}
              style={{ flex: 1, minWidth: 240 }}
            >
              <Input.TextArea
                rows={1}
                autoSize={{ minRows: 1, maxRows: 4 }}
                maxLength={1000}
                placeholder="记录一次沟通…"
              />
            </Form.Item>
            <Form.Item>
              <Button htmlType="submit" loading={addFollowUp.isPending}>
                添加
              </Button>
            </Form.Item>
          </Form>
        )}
        {c.followUps.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有跟进记录" />
        ) : (
          <Timeline
            items={c.followUps.map((f) => ({
              color: KIND[f.kind]?.color ?? 'blue',
              children: (
                <Space direction="vertical" size={0}>
                  <Space size={8} wrap>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {formatTime(f.createdAt)} · {f.user.displayName}
                    </Typography.Text>
                    {f.kind !== 'note' && KIND[f.kind] && (
                      <Tag color={KIND[f.kind].color}>
                        {KIND[f.kind].label}
                        {f.subscriptionId && subsByCode.get(f.subscriptionId)
                          ? ` ${subsByCode.get(f.subscriptionId)}`
                          : ''}
                      </Tag>
                    )}
                  </Space>
                  <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>{f.content}</Typography.Text>
                </Space>
              ),
            }))}
          />
        )}
      </Card>

      {editing && (
        <CustomerFormModal customer={c} onClose={() => setEditing(false)} onSaved={refresh} />
      )}
      {losing && <LostReasonModal customer={c} onClose={() => setLosing(false)} />}
      {transferring && (
        <TransferModal
          customerId={c.id}
          currentOwnerId={c.owner.id}
          onClose={() => setTransferring(false)}
          onDone={refresh}
        />
      )}
    </Space>
  );
}

function TransferModal({
  customerId,
  currentOwnerId,
  onClose,
  onDone,
}: {
  customerId: string;
  currentOwnerId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const { profile } = useAuth();
  const staff = useStaffOptions();
  const [ownerId, setOwnerId] = useState(currentOwnerId);
  const transfer = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/customers/{id}/transfer', {
          params: { path: { id: customerId } },
          body: { ownerId },
        }),
      ),
    onSuccess: () => {
      message.success('已更换负责人，名下订阅的续费提醒一起转给新负责人');
      onDone();
      onClose();
    },
  });
  const options = (staff.data ?? [])
    .filter((s) => profile?.dataScope === 'ALL' || s.teamId === profile?.teamId)
    .map((s) => ({ value: s.id, label: s.displayName }));
  return (
    <Modal
      open
      title="更换负责人"
      okText="确认"
      okButtonProps={{ disabled: ownerId === currentOwnerId }}
      confirmLoading={transfer.isPending}
      onOk={() => transfer.mutate()}
      onCancel={onClose}
    >
      <Typography.Paragraph type="secondary">
        客户和名下订阅（续费提醒）转给新负责人；历史订单的负责人不变。
      </Typography.Paragraph>
      <Select
        style={{ width: '100%' }}
        value={ownerId}
        onChange={setOwnerId}
        showSearch
        optionFilterProp="label"
        options={options}
      />
    </Modal>
  );
}
