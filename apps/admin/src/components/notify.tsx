import { useState } from 'react';
import { useNavigate } from 'react-router';
import { App, Badge, Button, Empty, List, Popover, Space, Switch, Tooltip, Typography } from 'antd';
import { BellOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { api, unwrap, type Schemas } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

dayjs.extend(relativeTime);

export type Notification = Schemas['NotificationDto'];

export const NOTIFY_KEYS = {
  unread: ['notifications', 'unread'] as const,
  latest: ['notifications', 'latest'] as const,
  duty: ['tasks', 'duty'] as const,
};

/** 「3 分钟前」这样的相对时间，鼠标放上去看具体时间 */
export function Ago({ at }: { at: string }) {
  return (
    <Tooltip title={dayjs(at).format('YYYY-MM-DD HH:mm')}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {dayjs(at).locale('zh-cn').fromNow()}
      </Typography.Text>
    </Tooltip>
  );
}

/** 点一条消息：标记已读，有链接就打开 */
export function useOpenNotification() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const read = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/api/notifications/{id}/read', { params: { path: { id } } })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
  return (n: Notification) => {
    if (!n.readAt) read.mutate(n.id);
    if (n.link) navigate(n.link);
  };
}

export function NotificationItem({
  n,
  onOpen,
  compact,
}: {
  n: Notification;
  onOpen: (n: Notification) => void;
  compact?: boolean;
}) {
  return (
    <List.Item
      onClick={() => onOpen(n)}
      style={{
        cursor: 'pointer',
        padding: compact ? '10px 12px' : '12px 16px',
        background: n.readAt ? undefined : 'var(--crm-unread-bg, #f0f7ff)',
        alignItems: 'flex-start',
      }}
    >
      <Space direction="vertical" size={2} style={{ width: '100%' }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
          <Typography.Text strong={!n.readAt}>
            {!n.readAt && <Badge status="processing" style={{ marginRight: 6 }} />}
            {n.title}
          </Typography.Text>
          <Ago at={n.createdAt} />
        </Space>
        {n.body && (
          <Typography.Paragraph
            type="secondary"
            style={{ margin: 0, whiteSpace: 'pre-line', fontSize: 13 }}
            ellipsis={compact ? { rows: 3 } : false}
          >
            {n.body}
          </Typography.Paragraph>
        )}
      </Space>
    </List.Item>
  );
}

/** 右上角铃铛：未读数每 30 秒刷新一次，点开看最近的消息 */
export function NotificationBell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const unread = useQuery({
    queryKey: NOTIFY_KEYS.unread,
    queryFn: () => unwrap(api.GET('/api/notifications/unread-count')),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const latest = useQuery({
    queryKey: NOTIFY_KEYS.latest,
    queryFn: () => unwrap(api.GET('/api/notifications', { params: { query: { pageSize: 8 } } })),
    enabled: open,
  });
  const readAll = useMutation({
    mutationFn: () => unwrap(api.POST('/api/notifications/read-all')),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const openOne = useOpenNotification();
  const count = unread.data?.unread ?? 0;

  const content = (
    <div style={{ width: 360, maxWidth: 'calc(100vw - 32px)' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 12px',
          borderBottom: '1px solid #f0f0f0',
        }}
      >
        <Typography.Text strong>消息{count > 0 ? `（${count} 条未读）` : ''}</Typography.Text>
        <Button
          type="link"
          size="small"
          disabled={count === 0}
          loading={readAll.isPending}
          onClick={() => readAll.mutate()}
        >
          全部已读
        </Button>
      </div>
      <div style={{ maxHeight: 420, overflowY: 'auto' }}>
        {latest.data?.items.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂时没有消息" />
        ) : (
          <List
            loading={latest.isPending}
            dataSource={latest.data?.items ?? []}
            renderItem={(n) => (
              <NotificationItem
                n={n}
                compact
                onOpen={(x) => {
                  setOpen(false);
                  openOne(x);
                }}
              />
            )}
          />
        )}
      </div>
      <div style={{ textAlign: 'center', borderTop: '1px solid #f0f0f0', padding: 6 }}>
        <Button
          type="link"
          size="small"
          onClick={() => {
            setOpen(false);
            navigate('/notifications');
          }}
        >
          查看全部消息
        </Button>
      </div>
    </div>
  );

  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      open={open}
      onOpenChange={setOpen}
      content={content}
      styles={{ body: { padding: 0 } }}
    >
      <Button
        type="text"
        aria-label={count > 0 ? `消息，${count} 条未读` : '消息'}
        icon={
          <Badge count={count} size="small" overflowCount={99}>
            <BellOutlined style={{ fontSize: 18 }} />
          </Badge>
        }
      />
    </Popover>
  );
}

/** 充值员在顶栏切换「在班 / 休息」：在班才会被自动派单 */
export function DutySwitch() {
  const { can, profile } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const isFulfiller = can('fulfillment:handle') && !profile?.permissions.includes('*');
  const duty = useQuery({
    queryKey: NOTIFY_KEYS.duty,
    queryFn: () => unwrap(api.GET('/api/tasks/duty')),
    enabled: isFulfiller,
    refetchInterval: 60_000,
  });
  const change = useMutation({
    mutationFn: (onDuty: boolean) => unwrap(api.POST('/api/tasks/duty', { body: { onDuty } })),
    onSuccess: (r) => {
      queryClient.setQueryData(NOTIFY_KEYS.duty, r);
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      if (r.onDuty) {
        message.success(
          r.moved ? `已上班，任务池里的 ${r.moved} 个任务派出来了` : '已上班，新任务会派给你',
        );
      } else {
        message.success(
          r.moved
            ? `已下班，没开始的 ${r.moved} 个任务转给了在班的同事或放回任务池`
            : '已下班，不再给你派新任务',
        );
      }
    },
  });
  if (!isFulfiller || !duty.data?.dispatchable) return null;
  return (
    <Tooltip title="在班时自动派单优先派给你；下班时还没开始的任务会转给在班的同事">
      <Space size={6}>
        <Switch
          size="small"
          checked={duty.data.onDuty}
          loading={change.isPending}
          onChange={(v) => change.mutate(v)}
          aria-label="在班"
        />
        <Typography.Text type={duty.data.onDuty ? undefined : 'secondary'}>
          {duty.data.onDuty ? '在班' : '休息中'}
        </Typography.Text>
      </Space>
    </Tooltip>
  );
}
