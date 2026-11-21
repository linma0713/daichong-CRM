import { useState } from 'react';
import { Button, Card, List, Segmented, Space, Typography } from 'antd';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../api/client';
import { NotificationItem, useOpenNotification } from '../components/notify';

/** 我的全部站内消息 */
export function NotificationsPage() {
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState({ page: 1, pageSize: 20 });
  const list = useQuery({
    queryKey: ['notifications', 'page', unreadOnly, page],
    queryFn: () =>
      unwrap(api.GET('/api/notifications', { params: { query: { ...page, unreadOnly } } })),
    placeholderData: keepPreviousData,
  });
  const readAll = useMutation({
    mutationFn: () => unwrap(api.POST('/api/notifications/read-all')),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const open = useOpenNotification();
  const unread = list.data?.unread ?? 0;

  return (
    <Card
      title="消息"
      extra={
        <Button
          disabled={unread === 0}
          loading={readAll.isPending}
          onClick={() => readAll.mutate()}
        >
          全部标记已读
        </Button>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          和你有关的事情会发到这里：派给你的任务、你负责的订单开通完成或失败、等你审批的退款、库存预警等。点一条消息会打开对应的页面。
        </Typography.Paragraph>
        <Segmented
          value={unreadOnly ? 'unread' : 'all'}
          onChange={(v) => {
            setUnreadOnly(v === 'unread');
            setPage((p) => ({ ...p, page: 1 }));
          }}
          options={[
            { value: 'all', label: '全部' },
            { value: 'unread', label: `未读${unread ? `（${unread}）` : ''}` },
          ]}
        />
        <List
          bordered
          loading={list.isFetching}
          dataSource={list.data?.items ?? []}
          locale={{ emptyText: unreadOnly ? '没有未读消息' : '暂时没有消息' }}
          renderItem={(n) => <NotificationItem n={n} onOpen={open} />}
          pagination={{
            current: page.page,
            pageSize: page.pageSize,
            total: list.data?.total,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 条`,
            onChange: (p, size) => setPage({ page: p, pageSize: size }),
          }}
        />
      </Space>
    </Card>
  );
}
