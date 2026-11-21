import { useState } from 'react';
import { Link } from 'react-router';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  type TableColumnsType,
} from 'antd';
import { PlusOutlined, ReloadOutlined, SendOutlined } from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_GROUP_EVENTS,
  NOTIFY_EVENTS,
  NOTIFY_EVENT_LABELS,
  OUTBOUND_STATUS_LABELS,
  parseWecomWebhook,
  type NotifyEvent,
  type OutboundStatus,
} from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { formatTime } from '../../components/format';

type Channel = Schemas['NotifyChannelDto'];
type Outbound = Schemas['OutboundMessageDto'];

const STATUS_COLORS: Record<OutboundStatus, string> = {
  PENDING: 'processing',
  SENT: 'success',
  FAILED: 'error',
};

/** 群消息是企业微信 markdown，界面上去掉标签显示纯文字 */
function plainContent(content: string): string {
  return content
    .replace(/<\/?font[^>]*>/g, '')
    .replace(/\*\*/g, '')
    .replace(/^> /gm, '')
    .replace(/\[在后台打开\]\([^)]*\)/g, '');
}

const GROUPS = [...new Set(NOTIFY_EVENTS.map((e) => e.group))];

function EventPicker({
  value,
  onChange,
}: {
  value?: NotifyEvent[];
  onChange?: (v: NotifyEvent[]) => void;
}) {
  return (
    <Checkbox.Group
      value={value}
      onChange={(v) => onChange?.(v as NotifyEvent[])}
      style={{ width: '100%' }}
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {GROUPS.map((g) => (
          <div key={g}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {g}
            </Typography.Text>
            <Row gutter={[8, 4]}>
              {NOTIFY_EVENTS.filter((e) => e.group === g).map((e) => (
                <Col xs={24} sm={12} key={e.value}>
                  <Checkbox value={e.value}>{e.label}</Checkbox>
                </Col>
              ))}
            </Row>
          </div>
        ))}
      </Space>
    </Checkbox.Group>
  );
}

function ChannelModal({ channel, onClose }: { channel: Channel | 'new'; onClose: () => void }) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<{ name: string; webhook?: string; events: NotifyEvent[] }>();
  const isNew = channel === 'new';
  const save = useMutation({
    mutationFn: async (v: { name: string; webhook?: string; events: NotifyEvent[] }) => {
      const webhook = v.webhook?.trim() || undefined;
      if (isNew) {
        return unwrap(
          api.POST('/api/notify-channels', {
            body: { name: v.name, webhook: webhook!, events: v.events },
          }),
        );
      }
      return unwrap(
        api.PATCH('/api/notify-channels/{id}', {
          params: { path: { id: channel.id } },
          body: { name: v.name, events: v.events, ...(webhook ? { webhook } : {}) },
        }),
      );
    },
    onSuccess: () => {
      message.success(isNew ? '已添加，可以点「发测试消息」确认群里能收到' : '已保存');
      void queryClient.invalidateQueries({ queryKey: ['notify-channels'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      title={isNew ? '添加企业微信群机器人' : `编辑「${channel.name}」`}
      okText="保存"
      width={640}
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={
          isNew
            ? { events: DEFAULT_GROUP_EVENTS }
            : { name: channel.name, events: channel.events as NotifyEvent[] }
        }
        onFinish={(v) => save.mutate(v)}
      >
        <Form.Item
          name="name"
          label="名称"
          rules={[{ required: true, message: '起个名字，比如「充值群」' }]}
        >
          <Input maxLength={40} placeholder="例如：充值群、老板群" />
        </Form.Item>
        <Form.Item
          name="webhook"
          label="机器人地址（Webhook）"
          extra={
            isNew
              ? '在企业微信群里：右上角「…」→ 群机器人 → 添加机器人 → 新创建一个 → 复制 Webhook 地址。地址等同于密码，系统加密保存。'
              : `现在用的机器人 key：${channel.webhookHint}。要换机器人才填，不换就留空。`
          }
          rules={[
            { required: isNew, message: '请粘贴机器人地址' },
            {
              validator: (_, v?: string) =>
                !v?.trim() || parseWecomWebhook(v)
                  ? Promise.resolve()
                  : Promise.reject(
                      new Error(
                        '应该是 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=… 这样的地址',
                      ),
                    ),
            },
          ]}
        >
          <Input.TextArea
            autoSize={{ minRows: 2 }}
            placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"
          />
        </Form.Item>
        <Form.Item
          name="events"
          label="推送哪些事件"
          extra="站内消息照常发给相关员工；勾上的事件同时推到这个群。"
          rules={[{ required: true, type: 'array', min: 1, message: '至少选一个事件' }]}
        >
          <EventPicker />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function NotifyChannelsPage() {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Channel | 'new' | null>(null);
  const [log, setLog] = useState<{
    page: number;
    pageSize: number;
    status?: OutboundStatus;
    channelId?: string;
  }>({
    page: 1,
    pageSize: 10,
  });
  const channels = useQuery({
    queryKey: ['notify-channels'],
    queryFn: () => unwrap(api.GET('/api/notify-channels')),
    refetchInterval: 30_000,
  });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => unwrap(api.GET('/api/settings')),
  });
  const messages = useQuery({
    queryKey: ['notify-channels', 'messages', log],
    queryFn: () => unwrap(api.GET('/api/notify-channels/messages', { params: { query: log } })),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['notify-channels'] });

  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) =>
      unwrap(
        api.PATCH('/api/notify-channels/{id}', {
          params: { path: { id: v.id } },
          body: { enabled: v.enabled },
        }),
      ),
    onSuccess: invalidate,
  });
  const test = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/api/notify-channels/{id}/test', { params: { path: { id } } })),
    onSuccess: (r) => {
      if (r.ok) message.success('测试消息已发出，去群里看看');
      else message.error(`发送失败：${r.error}`);
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/api/notify-channels/{id}', { params: { path: { id } } })),
    onSuccess: () => {
      message.success('已删除');
      invalidate();
    },
  });
  const retry = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/api/notify-channels/messages/{id}/retry', { params: { path: { id } } })),
    onSuccess: () => {
      message.success('已放回发送队列，稍后自动重发');
      invalidate();
    },
  });

  const columns: TableColumnsType<Channel> = [
    {
      title: '群',
      key: 'name',
      width: 170,
      render: (_, c) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{c.name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            key {c.webhookHint}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '推送的事件',
      key: 'events',
      render: (_, c) => (
        <Space size={[4, 4]} wrap>
          {c.events.map((e) => (
            <Tag key={e} style={{ marginInlineEnd: 0 }}>
              {NOTIFY_EVENT_LABELS[e as NotifyEvent] ?? e}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '发送情况',
      key: 'status',
      width: 220,
      render: (_, c) => (
        <Space direction="vertical" size={0}>
          <Typography.Text style={{ fontSize: 13 }}>
            最近发送：{c.lastSentAt ? formatTime(c.lastSentAt) : '还没发过'}
          </Typography.Text>
          {c.pending > 0 && (
            <Typography.Text type="secondary">待发送 {c.pending} 条</Typography.Text>
          )}
          {c.failed > 0 && (
            <Typography.Text type="danger">近 7 天失败 {c.failed} 条</Typography.Text>
          )}
          {c.lastError && (
            <Tooltip title={c.lastError}>
              <Typography.Text type="danger" ellipsis style={{ maxWidth: 200, fontSize: 12 }}>
                {c.lastError}
              </Typography.Text>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: '启用',
      key: 'enabled',
      width: 70,
      render: (_, c) => (
        <Switch
          size="small"
          checked={c.enabled}
          loading={toggle.isPending && toggle.variables?.id === c.id}
          onChange={(enabled) => toggle.mutate({ id: c.id, enabled })}
        />
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 210,
      render: (_, c) => (
        <Space size={0} wrap>
          <Button
            type="link"
            size="small"
            icon={<SendOutlined />}
            loading={test.isPending && test.variables === c.id}
            onClick={() => test.mutate(c.id)}
          >
            发测试消息
          </Button>
          <Button type="link" size="small" onClick={() => setEditing(c)}>
            编辑
          </Button>
          <Button
            type="link"
            size="small"
            danger
            onClick={() =>
              modal.confirm({
                title: `删除「${c.name}」？`,
                content: '还没发出去的消息会一起删除。以后要用可以重新添加。',
                okText: '删除',
                okButtonProps: { danger: true },
                onOk: () => remove.mutateAsync(c.id),
              })
            }
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const logColumns: TableColumnsType<Outbound> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 150,
      render: (v: string) => formatTime(v),
    },
    { title: '群', dataIndex: 'channelName', width: 110 },
    {
      title: '事件',
      dataIndex: 'event',
      width: 160,
      render: (e: NotifyEvent) => NOTIFY_EVENT_LABELS[e] ?? e,
    },
    {
      title: '内容',
      dataIndex: 'content',
      render: (c: string) => (
        <Typography.Paragraph
          style={{ margin: 0, whiteSpace: 'pre-line', fontSize: 13 }}
          ellipsis={{ rows: 3, expandable: true, symbol: '展开' }}
        >
          {plainContent(c)}
        </Typography.Paragraph>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 170,
      render: (_, m) => (
        <Space direction="vertical" size={0}>
          <Space size={4}>
            <Tag color={STATUS_COLORS[m.status]}>{OUTBOUND_STATUS_LABELS[m.status]}</Tag>
            {m.status === 'FAILED' && (
              <Button
                type="link"
                size="small"
                style={{ padding: 0 }}
                loading={retry.isPending && retry.variables === m.id}
                onClick={() => retry.mutate(m.id)}
              >
                重发
              </Button>
            )}
          </Space>
          {m.attempts > 1 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              试了 {m.attempts} 次
            </Typography.Text>
          )}
          {m.lastError && m.status !== 'SENT' && (
            <Tooltip title={m.lastError}>
              <Typography.Text type="danger" ellipsis style={{ maxWidth: 160, fontSize: 12 }}>
                {m.lastError}
              </Typography.Text>
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="消息推送"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
            添加群机器人
          </Button>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            系统里发生的事（新任务、任务超时、退款待审批、库存不足等）会发站内消息给相关员工，右上角铃铛能看到。
            把企业微信群机器人加到这里，勾选的事件会同时推到群里，大家在手机上也能马上看到。
            每日早报在每天 {settings.data?.dailyDigestHour ?? 9} 点推送，时间可以在
            <Link to="/settings">业务设置</Link>里改。
          </Typography.Paragraph>
          {channels.data?.length === 0 && (
            <Alert
              type="info"
              showIcon
              message="还没有添加群机器人"
              description="不加也没关系，站内消息照常发送。需要推到企业微信群时，在群里添加一个机器人，把它的 Webhook 地址粘贴过来即可。"
            />
          )}
          {(channels.data?.length ?? 0) > 0 && (
            <Table
              rowKey="id"
              size="middle"
              loading={channels.isFetching}
              columns={columns}
              dataSource={channels.data}
              pagination={false}
              scroll={{ x: 860 }}
            />
          )}
        </Space>
      </Card>

      <Card
        title="群消息发送记录"
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void messages.refetch()}>
            刷新
          </Button>
        }
      >
        <div className="page-toolbar">
          <div className="page-toolbar-filters">
            <Select
              placeholder="群"
              allowClear
              style={{ width: 160 }}
              options={channels.data?.map((c) => ({ value: c.id, label: c.name }))}
              onChange={(channelId?: string) => setLog((l) => ({ ...l, page: 1, channelId }))}
            />
            <Select
              placeholder="状态"
              allowClear
              style={{ width: 120 }}
              options={(Object.keys(OUTBOUND_STATUS_LABELS) as OutboundStatus[]).map((s) => ({
                value: s,
                label: OUTBOUND_STATUS_LABELS[s],
              }))}
              onChange={(status?: OutboundStatus) => setLog((l) => ({ ...l, page: 1, status }))}
            />
          </div>
        </div>
        <Table
          rowKey="id"
          size="small"
          loading={messages.isFetching}
          columns={logColumns}
          dataSource={messages.data?.items}
          scroll={{ x: 860 }}
          locale={{ emptyText: '还没有群消息' }}
          pagination={{
            current: log.page,
            pageSize: log.pageSize,
            total: messages.data?.total,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (page, pageSize) => setLog((l) => ({ ...l, page, pageSize })),
          }}
        />
      </Card>
      {editing && <ChannelModal channel={editing} onClose={() => setEditing(null)} />}
    </Space>
  );
}
