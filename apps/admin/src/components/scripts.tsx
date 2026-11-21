import { useState } from 'react';
import { Link } from 'react-router';
import { Alert, App, Button, Empty, Modal, Segmented, Space, Spin, Tag, Typography } from 'antd';
import { CopyOutlined, MessageOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FULFILLMENT_TYPE_LABELS,
  SCRIPT_CATEGORIES,
  formatCents,
  missingVariables,
  renderScript,
  termLabel,
  type ScriptCategory,
  type ScriptVars,
} from '@crm/shared';
import { api, unwrap, type Schemas } from '../api/client';
import { useProducts } from '../api/queries';
import { useAuth } from '../auth/AuthProvider';
import { formatTime } from './format';

/** 话术库：选一条话术，自动填上客户信息，一键复制到微信 */

export function useScripts() {
  return useQuery({
    queryKey: ['scripts'],
    queryFn: () => unwrap(api.GET('/api/scripts')),
    staleTime: 60_000,
  });
}

/**
 * 复制到剪贴板。局域网 http 地址下浏览器不给用 navigator.clipboard，退回到老办法。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续用下面的办法
  }
  const el = document.createElement('textarea');
  el.value = text;
  el.setAttribute('readonly', '');
  el.style.position = 'fixed';
  el.style.opacity = '0';
  document.body.appendChild(el);
  el.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(el);
  return ok;
}

type Subscription = Pick<
  Schemas['SubscriptionDto'],
  'planId' | 'planName' | 'fulfillmentType' | 'endAt' | 'daysLeft' | 'account' | 'owner'
>;

/** 从订阅算话术变量（续费价取同套餐、同履约方式在售商品里时长最短的那个） */
export function useSubscriptionVars(
  sub: Subscription | null | undefined,
  customerName: string,
): ScriptVars {
  const products = useProducts(true);
  if (!sub) return { 客户称呼: customerName };
  const renewal = (products.data ?? [])
    .filter((p) => p.planId === sub.planId && p.fulfillmentType === sub.fulfillmentType)
    .sort((a, b) => a.termMonths - b.termMonths)[0];
  return {
    客户称呼: customerName,
    套餐: `${sub.planName}（${FULFILLMENT_TYPE_LABELS[sub.fulfillmentType]}）`,
    到期日: formatTime(sub.endAt).slice(0, 10),
    剩余天数: Math.max(0, sub.daysLeft),
    账号: sub.account.email,
    续费价: renewal
      ? `${formatCents(renewal.priceCents)}${renewal.termMonths > 1 ? ` / ${termLabel(renewal.termMonths)}` : ''}`
      : undefined,
    客服: sub.owner.displayName,
  };
}

/** 「话术」按钮：打开话术选择框 */
export function ScriptPicker({
  category,
  vars,
  size = 'small',
  type = 'link',
  text = '话术',
}: {
  category: ScriptCategory;
  vars: ScriptVars;
  size?: 'small' | 'middle';
  type?: 'link' | 'default';
  text?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} type={type} icon={<MessageOutlined />} onClick={() => setOpen(true)}>
        {text}
      </Button>
      {open && <ScriptModal category={category} vars={vars} onClose={() => setOpen(false)} />}
    </>
  );
}

function ScriptModal({
  category,
  vars,
  onClose,
}: {
  category: ScriptCategory;
  vars: ScriptVars;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const scripts = useScripts();
  const [current, setCurrent] = useState<ScriptCategory>(category);
  const used = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/api/scripts/{id}/used', { params: { path: { id } } })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['scripts'] }),
  });
  const list = (scripts.data ?? []).filter((s) => s.category === current);
  const counts = new Map<string, number>();
  for (const s of scripts.data ?? []) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);

  const copy = async (s: Schemas['ScriptDto'], text: string) => {
    if (await copyText(text)) {
      message.success('已复制，粘贴到微信发给客户即可');
      used.mutate(s.id);
    } else {
      message.error('浏览器不允许自动复制，请手动选中文字复制');
    }
  };

  return (
    <Modal
      open
      title="选择话术"
      footer={
        can('script:write') ? (
          <Link to="/scripts" onClick={onClose}>
            管理话术库
          </Link>
        ) : null
      }
      onCancel={onClose}
      width={600}
    >
      <Segmented<ScriptCategory>
        value={current}
        onChange={setCurrent}
        options={SCRIPT_CATEGORIES.map((c) => ({
          value: c.value,
          label: counts.get(c.value) ? `${c.label} ${counts.get(c.value)}` : c.label,
        }))}
        style={{ marginBottom: 12, maxWidth: '100%', overflowX: 'auto' }}
      />
      {scripts.isLoading ? (
        <Spin style={{ display: 'block', margin: 24 }} />
      ) : list.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个分类还没有话术" />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {list.map((s) => {
            const text = renderScript(s.content, vars);
            const missing = missingVariables(text);
            return (
              <div key={s.id} className="script-card">
                <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
                  <Space size={6} wrap>
                    <Typography.Text strong>{s.title}</Typography.Text>
                    {s.useCount > 0 && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        用过 {s.useCount} 次
                      </Typography.Text>
                    )}
                  </Space>
                  <Button
                    type="primary"
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={() => void copy(s, text)}
                  >
                    复制
                  </Button>
                </Space>
                <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>
                  {text}
                </Typography.Paragraph>
                {missing.length > 0 && (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginTop: 8 }}
                    message={
                      <span>
                        这些信息系统里没有，发之前手动改一下：
                        {missing.map((m) => (
                          <Tag key={m} style={{ marginLeft: 4 }}>
                            {`{${m}}`}
                          </Tag>
                        ))}
                      </span>
                    }
                  />
                )}
              </div>
            );
          })}
        </Space>
      )}
    </Modal>
  );
}
