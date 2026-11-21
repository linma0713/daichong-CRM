import { useEffect } from 'react';
import { Link } from 'react-router';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Typography,
} from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ONLINE_PAY_CHANNELS,
  PAYMENT_METHODS,
  PAY_LINK_MINUTES,
  TICKET_TYPES,
  TICKET_TYPE_LABELS,
  type PaymentMethod,
} from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { useBusinessSettings } from '../../api/queries';

type Settings = Schemas['BusinessSettingsDto'];
/** 标签模式的下拉框只接受字符串，提交时再转成数字；手续费在界面上按百分比填 */
type SettingsForm = Omit<
  Settings,
  | 'reminderDays'
  | 'paymentFeeBp'
  | 'commissionRatesBp'
  | 'vipThresholdCents'
  | 'referralRewardCents'
> & {
  reminderDays: string[];
  vipYuan: number;
  rewardYuan: number;
  feePercent: Record<PaymentMethod, number>;
  commissionPercent: { first: number; renewal: number; parent: number };
};

const COMMISSION_FIELDS = [
  ['first', '客户首单'],
  ['renewal', '续费 / 再买'],
  ['parent', '上级管理'],
] as const;

const bpToPercent = (bp: Settings['paymentFeeBp']) =>
  Object.fromEntries(PAYMENT_METHODS.map((m) => [m.value, (bp[m.value] ?? 0) / 100])) as Record<
    PaymentMethod,
    number
  >;
const percentToBp = (p: Record<PaymentMethod, number>) =>
  Object.fromEntries(
    PAYMENT_METHODS.map((m) => [m.value, Math.round((p[m.value] ?? 0) * 100)]),
  ) as Settings['paymentFeeBp'];

export function SettingsPage() {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const settings = useBusinessSettings();
  const [form] = Form.useForm<SettingsForm>();
  const payChannel = Form.useWatch('onlinePayChannel', form);

  useEffect(() => {
    if (settings.data) {
      const { paymentFeeBp, commissionRatesBp, vipThresholdCents, referralRewardCents, ...rest } =
        settings.data;
      form.setFieldsValue({
        ...rest,
        vipYuan: vipThresholdCents / 100,
        rewardYuan: referralRewardCents / 100,
        reminderDays: settings.data.reminderDays.map(String),
        feePercent: bpToPercent(paymentFeeBp),
        commissionPercent: {
          first: commissionRatesBp.first / 100,
          renewal: commissionRatesBp.renewal / 100,
          parent: commissionRatesBp.parent / 100,
        },
      });
    }
  }, [settings.data, form]);

  const save = useMutation({
    mutationFn: (v: SettingsForm) => {
      const days = v.reminderDays.map(Number);
      if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 60)) {
        return Promise.reject(new Error('提醒天数要填 0–60 之间的整数'));
      }
      const { feePercent, commissionPercent, vipYuan, rewardYuan, ...rest } = v;
      const toBp = (p: number) => Math.round((p ?? 0) * 100);
      return unwrap(
        api.PATCH('/api/settings', {
          body: {
            ...rest,
            vipThresholdCents: Math.round((vipYuan ?? 0) * 100),
            referralRewardCents: Math.round((rewardYuan ?? 0) * 100),
            reminderDays: days,
            paymentFeeBp: percentToBp(feePercent),
            commissionRatesBp: {
              first: toBp(commissionPercent.first),
              renewal: toBp(commissionPercent.renewal),
              parent: toBp(commissionPercent.parent),
            },
          },
        }),
      );
    },
    onSuccess: (saved) => {
      message.success('已保存');
      queryClient.setQueryData(['settings'], saved);
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
  });

  const sweep = useMutation({
    mutationFn: () => unwrap(api.POST('/api/jobs/sweep')),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      modal.info({
        title: r.skipped ? '另一个巡检正在运行，这次跳过' : '巡检完成',
        content: (
          <Descriptions column={1} size="small" style={{ marginTop: 12 }}>
            <Descriptions.Item label="标记为已到期">{r.expired}</Descriptions.Item>
            <Descriptions.Item label="新建回收成品号任务">{r.reclaimTasks}</Descriptions.Item>
            <Descriptions.Item label="新建内部续费任务">{r.internalRenewTasks}</Descriptions.Item>
            <Descriptions.Item label="新建取消自动续订任务">
              {r.cancelAutoRenewTasks}
            </Descriptions.Item>
            <Descriptions.Item label="超时升级的工单">{r.escalatedTickets}</Descriptions.Item>
            <Descriptions.Item label="自动关闭的工单">{r.closedTickets}</Descriptions.Item>
            <Descriptions.Item label="解冻的代理佣金">{r.releasedCommissions} 条</Descriptions.Item>
            <Descriptions.Item label="自动生成的上月对账单">
              {r.statementsGenerated} 张
            </Descriptions.Item>
            <Descriptions.Item label="分层有变化的客户">
              {r.customerStageChanges} 位
            </Descriptions.Item>
          </Descriptions>
        ),
      });
    },
  });

  const notifyScan = useMutation({
    mutationFn: () => unwrap(api.POST('/api/jobs/notify-scan')),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      void queryClient.invalidateQueries({ queryKey: ['notify-channels'] });
      modal.info({
        title: r.skipped ? '另一个消息巡检正在运行，这次跳过' : '消息巡检完成',
        content: (
          <Descriptions column={1} size="small" style={{ marginTop: 12 }}>
            <Descriptions.Item label="发出的任务超时提醒">{r.overdueTasks} 个</Descriptions.Item>
            <Descriptions.Item label="新出现的库存预警">{r.inventoryAlerts} 项</Descriptions.Item>
            <Descriptions.Item label="每日早报">
              {r.digestSent ? '已推送' : '今天已推送过、还没到钟点，或没有群订阅早报'}
            </Descriptions.Item>
          </Descriptions>
        ),
      });
    },
  });

  return (
    <Space direction="vertical" size={16} style={{ width: '100%', maxWidth: 720 }}>
      <Card title="业务设置" loading={settings.isLoading}>
        <Form<SettingsForm> form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <Form.Item
            name="exchangeRate"
            label="美元汇率"
            rules={[{ required: true }]}
            extra="1 美元 = ? 人民币，用于估算商品成本和毛利"
          >
            <InputNumber min={1} max={20} step={0.01} precision={4} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item
            name="reminderDays"
            label="续费提醒节奏"
            rules={[{ required: true, message: '至少设置一个提醒时间' }]}
            extra="到期前第几天提醒客服跟进，可以设置多个，例如 7、3、1"
          >
            <Select
              mode="tags"
              style={{ width: 320 }}
              tokenSeparators={[',', '，', ' ']}
              options={['7', '5', '3', '2', '1'].map((d) => ({ value: d, label: `${d} 天` }))}
              maxCount={5}
            />
          </Form.Item>
          <Form.Item
            name="activateSlaHours"
            label="开通时限（小时）"
            rules={[{ required: true }]}
            extra="收齐款后，开通 / 续费任务最晚多少小时内完成，超时会标红"
          >
            <InputNumber min={1} max={72} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item
            name="upstreamLeadDays"
            label="上游扣费提前量（天）"
            rules={[{ required: true }]}
            extra="上游扣费前几天生成「内部续费」或「取消自动续订」任务"
          >
            <InputNumber min={1} max={10} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item
            label="收款手续费率（%）"
            extra="确认收款时按收款方式自动计算手续费，计入每单毛利。例如微信商户 0.6%"
          >
            <Space wrap>
              {PAYMENT_METHODS.map((m) => (
                <Form.Item key={m.value} name={['feePercent', m.value]} noStyle>
                  <InputNumber
                    min={0}
                    max={20}
                    step={0.1}
                    precision={2}
                    prefix={<span style={{ color: '#8c8c8c', marginRight: 4 }}>{m.label}</span>}
                    style={{ width: 150 }}
                  />
                </Form.Item>
              ))}
            </Space>
          </Form.Item>
          <Form.Item
            name="accountStockLow"
            label="成品号库存预警（个）"
            rules={[{ required: true }]}
            extra="每个在卖成品号的套餐，在库数量低于这个值时在首页和库存页提醒"
          >
            <InputNumber min={0} max={1000} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item
            label="售后工单处理时限（小时）"
            extra="按问题类型设置，超过时限还没解决的工单会自动升级、在首页标红；等客户回复期间不算"
          >
            <Space wrap>
              {TICKET_TYPES.map((t) => (
                <Form.Item
                  key={t}
                  name={['ticketSlaHours', t]}
                  noStyle
                  rules={[{ required: true }]}
                >
                  <InputNumber
                    min={1}
                    max={720}
                    precision={0}
                    prefix={
                      <span style={{ color: '#8c8c8c', marginRight: 4 }}>
                        {TICKET_TYPE_LABELS[t]}
                      </span>
                    }
                    style={{ width: 150 }}
                  />
                </Form.Item>
              ))}
            </Space>
          </Form.Item>
          <Form.Item
            name="ticketAutoCloseHours"
            label="工单自动关闭（小时）"
            rules={[{ required: true }]}
            extra="工单标记「已解决」后，客户没有再反馈，超过这个时间自动关闭"
          >
            <InputNumber min={1} max={720} style={{ width: 200 }} />
          </Form.Item>
          <Typography.Title level={5} style={{ marginTop: 8 }}>
            客户分层
          </Typography.Title>
          <Form.Item
            name="vipYuan"
            label="VIP 门槛（元）"
            rules={[{ required: true }]}
            extra="客户累计实付（已收 − 已退）满这个数自动标 VIP，客户列表可以单独筛选"
          >
            <InputNumber min={0} max={1000000} precision={0} prefix="¥" style={{ width: 200 }} />
          </Form.Item>
          <Form.Item
            name="recallWindowDays"
            label="召回期（天）"
            rules={[{ required: true }]}
            extra="客户没有服务中的订阅后，这么多天内算「沉睡」（进召回名单），超过算「流失」"
          >
            <InputNumber min={1} max={365} style={{ width: 200 }} />
          </Form.Item>
          <Typography.Title level={5} style={{ marginTop: 8 }}>
            转介绍奖励
          </Typography.Title>
          <Form.Item
            name="rewardYuan"
            label="每推荐成交一位新客户奖励（元）"
            rules={[{ required: true }]}
            extra="老客户推荐的新客户第一单收齐款后，自动给推荐人生成一条「待发放」奖励，在「渠道与营销」里发放。填 0 表示不发奖励"
          >
            <InputNumber min={0} max={100000} precision={2} prefix="¥" style={{ width: 200 }} />
          </Form.Item>
          <Typography.Title level={5} style={{ marginTop: 8 }}>
            代理佣金
          </Typography.Title>
          <Form.Item
            label="默认佣金比例（%）"
            extra="直推代理：客户首单按「首单」，之后的续费、再买按「续费」；上级代理另拿「上级管理」。商品或单个代理可以单独设置，改比例只影响之后的新订单"
          >
            <Space wrap>
              {COMMISSION_FIELDS.map(([key, label]) => (
                <Form.Item
                  key={key}
                  name={['commissionPercent', key]}
                  noStyle
                  rules={[{ required: true }]}
                >
                  <InputNumber
                    min={0}
                    max={50}
                    step={0.5}
                    precision={2}
                    prefix={<span style={{ color: '#8c8c8c', marginRight: 4 }}>{label}</span>}
                    suffix="%"
                    style={{ width: 180 }}
                  />
                </Form.Item>
              ))}
            </Space>
          </Form.Item>
          <Form.Item
            name="commissionIncludeWarranty"
            label="佣金基数包含质保费"
            valuePropName="checked"
            extra="关闭时佣金按「应收 − 质保费」算；退款按退款金额占比扣减佣金"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="commissionFreezeDays"
            label="佣金冻结期（天）"
            rules={[{ required: true }]}
            extra="没加购质保的订单，完成后冻结这么多天，期间退款佣金作废；加购质保的按服务月逐月释放"
          >
            <InputNumber min={0} max={90} style={{ width: 200 }} />
          </Form.Item>
          <Typography.Title level={5} style={{ marginTop: 8 }}>
            在线收款
          </Typography.Title>
          <Form.Item
            name="onlinePayChannel"
            label="收款通道"
            rules={[{ required: true }]}
            extra="开启后，订单详情里可以给客户发收款链接（带二维码），客户付款后系统自动确认收款、派开通任务"
          >
            <Select options={[...ONLINE_PAY_CHANNELS]} style={{ width: 260 }} />
          </Form.Item>
          {payChannel === 'mock' && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message="模拟通道只用来测试流程"
              description="客户打开链接点「模拟付款成功」就算付了款，不会真的扣钱。正式收款前要接入真实的支付通道（支付宝 / 微信支付等，需要你们的商户号），在那之前不要把模拟链接发给真实客户。"
            />
          )}
          <Form.Item
            name="payLinkMinutes"
            label="链接有效期（分钟）"
            rules={[{ required: true }]}
            extra="超过时间客户就付不了，要重新生成。30 分钟到 1 天比较合适"
          >
            <InputNumber
              min={PAY_LINK_MINUTES.min}
              max={PAY_LINK_MINUTES.max}
              precision={0}
              style={{ width: 200 }}
            />
          </Form.Item>
          <Form.Item
            name="payShopName"
            label="付款页显示的店铺名称"
            extra="客户打开付款页时最上面显示的名字；空着就只显示「订单付款」"
          >
            <Input maxLength={30} showCount placeholder="例如：小林代充" style={{ width: 320 }} />
          </Form.Item>
          <Typography.Title level={5} style={{ marginTop: 8 }}>
            消息
          </Typography.Title>
          <Form.Item
            name="dailyDigestHour"
            label="每日早报时间（点）"
            rules={[{ required: true }]}
            extra={
              <>
                每天这个钟点（北京时间）往订阅了早报的企业微信群推送昨日经营数字和今天的待办。群机器人在
                <Link to="/system/notify">消息推送</Link>里添加
              </>
            }
          >
            <InputNumber min={0} max={23} style={{ width: 200 }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={save.isPending}>
            保存
          </Button>
        </Form>
      </Card>
      <Card title="到期巡检">
        <Typography.Paragraph type="secondary">
          系统每小时自动检查一次：把到期的订阅标记为「已到期」，并按上游扣费时间生成内部续费、取消自动续订、回收成品号任务；售后工单超时升级、已解决的到时自动关闭；刷新客户分层。
          改了设置或手动校正订阅后，可以立即运行一次。
        </Typography.Paragraph>
        <Button loading={sweep.isPending} onClick={() => sweep.mutate()}>
          立即运行巡检
        </Button>
      </Card>
      <Card title="消息巡检">
        <Typography.Paragraph type="secondary">
          系统每 5 分钟自动检查一次：开通 /
          续费任务过了截止时间还没完成，提醒负责的充值员；付款资源余额或成品号库存跌破预警线，提醒管库存的人；到了早报时间往企业微信群推送早报。
        </Typography.Paragraph>
        <Button loading={notifyScan.isPending} onClick={() => notifyScan.mutate()}>
          立即运行消息巡检
        </Button>
      </Card>
    </Space>
  );
}
