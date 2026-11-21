import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Empty, List, Segmented, Spin } from 'antd';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../api/client';
import { NotificationItem, type Notification } from '../components/notify';
import { mobilePathFor } from './device';
import { MobilePage } from './MobileLayout';

const PAGE_SIZE = 20;

/** 手机版消息：点一条标记已读，有手机版页面就打开手机版 */
export function MobileMessagesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const list = useInfiniteQuery({
    queryKey: ['notifications', 'mobile', unreadOnly],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/notifications', {
          params: { query: { page: pageParam, pageSize: PAGE_SIZE, unreadOnly } },
        }),
      ),
    initialPageParam: 1,
    getNextPageParam: (last, all) =>
      all.length * PAGE_SIZE < last.total ? all.length + 1 : undefined,
  });
  const read = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/api/notifications/{id}/read', { params: { path: { id } } })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const readAll = useMutation({
    mutationFn: () => unwrap(api.POST('/api/notifications/read-all')),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const unread = list.data?.pages[0]?.unread ?? 0;
  const open = (n: Notification) => {
    if (!n.readAt) read.mutate(n.id);
    if (n.link) navigate(mobilePathFor(n.link) ?? n.link);
  };

  return (
    <MobilePage
      title="消息"
      extra={
        <Button
          type="link"
          size="small"
          disabled={unread === 0}
          loading={readAll.isPending}
          onClick={() => readAll.mutate()}
        >
          全部已读
        </Button>
      }
    >
      <div className="m-toolbar">
        <Segmented
          block
          value={unreadOnly ? 'unread' : 'all'}
          onChange={(v) => setUnreadOnly(v === 'unread')}
          options={[
            { value: 'all', label: '全部' },
            { value: 'unread', label: `未读${unread ? `（${unread}）` : ''}` },
          ]}
        />
      </div>
      {list.isLoading ? (
        <Spin style={{ display: 'block', margin: 32 }} />
      ) : items.length === 0 ? (
        <Empty
          style={{ marginTop: 48 }}
          description={unreadOnly ? '没有未读消息' : '暂时没有消息'}
        />
      ) : (
        <div className="m-list">
          <List
            className="m-messages"
            dataSource={items}
            renderItem={(n) => <NotificationItem n={n} onOpen={open} />}
          />
          {list.hasNextPage && (
            <Button
              block
              loading={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              加载更多
            </Button>
          )}
        </div>
      )}
    </MobilePage>
  );
}
