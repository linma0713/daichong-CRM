import { useEffect } from 'react';
import {
  App,
  Button,
  Card,
  Descriptions,
  Form,
  InputNumber,
  Select,
  Space,
  Typography,
} from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, unwrap, type Schemas } from '../../api/client';
import { useBusinessSettings } from '../../api/queries';

type Settings = Schemas['BusinessSettingsDto'];
/** 标签模式的下拉框只接受字符串，提交时再转成数字 */
type SettingsForm = Omit<Settings, 'reminderDays'> & { reminderDays: string[] };

export function SettingsPage() {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const settings = useBusinessSettings();
  const [form] = Form.useForm<SettingsForm>();

  useEffect(() => {
    if (settings.data) {
      form.setFieldsValue({
        ...settings.data,
        reminderDays: settings.data.reminderDays.map(String),
      });
    }
  }, [settings.data, form]);

  const save = useMutation({
    mutationFn: (v: SettingsForm) => {
      const days = v.reminderDays.map(Number);
      if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 60)) {
        return Promise.reject(new Error('提醒天数要填 0–60 之间的整数'));
      }
      return unwrap(api.PATCH('/api/settings', { body: { ...v, reminderDays: days } }));
    },
    onSuccess: (saved) => {
      message.success('已保存');
      queryClient.setQueryData(['settings'], saved);
      void queryClient.invalidateQueries({ queryKey: ['products'] });
    },
  });

  const sweep = useMutation({
    mutationFn: () => unwrap(api.POST('/api/jobs/sweep')),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
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
          <Button type="primary" htmlType="submit" loading={save.isPending}>
            保存
          </Button>
        </Form>
      </Card>
      <Card title="到期巡检">
        <Typography.Paragraph type="secondary">
          系统每小时自动检查一次：把到期的订阅标记为「已到期」，并按上游扣费时间生成内部续费、取消自动续订、回收成品号任务。
          改了设置或手动校正订阅后，可以立即运行一次。
        </Typography.Paragraph>
        <Button loading={sweep.isPending} onClick={() => sweep.mutate()}>
          立即运行巡检
        </Button>
      </Card>
    </Space>
  );
}
