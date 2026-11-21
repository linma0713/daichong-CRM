import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button, Empty, Segmented, Spin, Typography } from 'antd';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api, unwrap, type QueryOf, type Schemas } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { useBusinessSettings } from '../api/queries';
import { DaysLeft } from '../components/business';
import { formatShortTime, formatTime } from '../components/format';
import { ReminderModal } from '../pages/subscriptions/SubscriptionsPage';
import { MobilePage } from './MobileLayout';

type Subscription = Schemas['SubscriptionDto'];
type View = 'remind' | 'expiring';
const PAGE_SIZE = 20;

/** 手机版续费提醒：快到期还没提醒的订阅，提醒完记一笔 */
export function MobileRenewalsPage() {
  const { can } = useAuth();
  const settings = useBusinessSettings();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'expiring' ? 'expiring' : 'remind';
  const [reminding, setReminding] = useState<Subscription | null>(null);
  const query: QueryOf<'/api/subscriptions'> =
    view === 'remind' ? { needsReminder: true } : { expiringDays: 7 };
  const list = useInfiniteQuery({
    queryKey: ['subscriptions', 'mobile', query],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/subscriptions', {
          params: { query: { ...query, page: pageParam, pageSize: PAGE_SIZE } },
        }),
      ),
    initialPageParam: 1,
    getNextPageParam: (last, all) =>
      all.length * PAGE_SIZE < last.total ? all.length + 1 : undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const canWrite = can('customer:write');
  const days = settings.data?.reminderDays;

  return (
    <MobilePage title="续费提醒" back="/m">
      <div className="m-toolbar">
        <Segmented
          block
          value={view}
          onChange={(v) => setParams({ view: v as string }, { replace: true })}
          options={[
            { value: 'remind', label: '要提醒' },
            { value: 'expiring', label: '7 天内到期' },
          ]}
        />
        {view === 'remind' && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            按设置的节奏{days ? `（到期前 ${days.join(' / ')} 天，以及到期后 7 天内）` : ''}
            该提醒续费的订阅。联系过客户后点「记录提醒」，这个阶段就不再出现。
          </Typography.Text>
        )}
      </div>
      {list.isLoading ? (
        <Spin style={{ display: 'block', margin: 32 }} />
      ) : items.length === 0 ? (
        <Empty
          style={{ marginTop: 48 }}
          description={view === 'remind' ? '都提醒过了' : '7 天内没有到期的订阅'}
        />
      ) : (
        <div className="m-list">
          {items.map((s) => (
            <div key={s.id} className={`m-card${s.daysLeft <= 3 ? ' m-card-danger' : ''}`}>
              <button
                type="button"
                className="m-card-link"
                onClick={() => navigate(`/m/customers/${s.customer.id}`)}
              >
                <div className="m-card-row">
                  <span className="m-card-title">
                    {s.customer.name}
                    <span className="m-card-sub">{s.planName}</span>
                  </span>
                  <DaysLeft days={s.daysLeft} status={s.status} />
                </div>
                <div className="m-card-row m-card-meta">
                  <span>{formatTime(s.endAt).slice(0, 10)} 到期</span>
                  <span>
                    {s.lastRemindedAt
                      ? `上次提醒 ${formatShortTime(s.lastRemindedAt)}`
                      : '还没提醒过'}
                  </span>
                </div>
              </button>
              {canWrite && (
                <Button
                  block
                  type={s.needsReminder ? 'primary' : 'default'}
                  style={{ marginTop: 8 }}
                  onClick={() => setReminding(s)}
                >
                  记录提醒
                </Button>
              )}
            </div>
          ))}
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
      {reminding && <ReminderModal subscription={reminding} onClose={() => setReminding(null)} />}
    </MobilePage>
  );
}
