import { useRef, useState } from 'react';
import {
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd';
import { CopyOutlined, PlusOutlined } from '@ant-design/icons';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  SCRIPT_CATEGORIES,
  SCRIPT_CATEGORY_LABELS,
  SCRIPT_VARIABLES,
  renderScript,
  type ScriptCategory,
  type ScriptVars,
} from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { copyText, useScripts } from '../../components/scripts';
import { formatTime } from '../../components/format';

type Script = Schemas['ScriptDto'];

const EXAMPLE_VARS = Object.fromEntries(
  SCRIPT_VARIABLES.map((v) => [v.key, v.example]),
) as ScriptVars;

export function ScriptsPage() {
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const scripts = useScripts();
  const [category, setCategory] = useState<ScriptCategory | 'all'>('all');
  const [editing, setEditing] = useState<Script | 'new' | null>(null);
  const canWrite = can('script:write');

  const remove = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/api/scripts/{id}', { params: { path: { id } } })),
    onSuccess: () => {
      message.success('已删除');
      void queryClient.invalidateQueries({ queryKey: ['scripts'] });
    },
  });

  // 「全部」按分类的固定顺序排（接口按字母排），同一分类里保持接口的顺序
  const order = new Map<string, number>(SCRIPT_CATEGORIES.map((c, i) => [c.value, i]));
  const data = (scripts.data ?? [])
    .filter((s) => category === 'all' || s.category === category)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (order.get(a.s.category) ?? 99) - (order.get(b.s.category) ?? 99) || a.i - b.i)
    .map(({ s }) => s);
  const counts = new Map<string, number>();
  for (const s of scripts.data ?? []) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);

  const columns: TableColumnsType<Script> = [
    {
      title: '话术',
      key: 'title',
      render: (_, s) => (
        <Space direction="vertical" size={2} style={{ maxWidth: 560 }}>
          <Space size={6}>
            <Typography.Text strong>{s.title}</Typography.Text>
            <Tag>{SCRIPT_CATEGORY_LABELS[s.category as ScriptCategory] ?? s.category}</Tag>
          </Space>
          <Typography.Paragraph
            type="secondary"
            style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 13 }}
            ellipsis={{ rows: 3, expandable: true, symbol: '展开' }}
          >
            {s.content}
          </Typography.Paragraph>
        </Space>
      ),
    },
    {
      title: '使用',
      key: 'use',
      width: 140,
      render: (_, s) => (
        <Space direction="vertical" size={0}>
          <span>{s.useCount} 次</span>
          {s.lastUsedAt && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              最近 {formatTime(s.lastUsedAt).slice(0, 10)}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    { title: '排序', dataIndex: 'sortOrder', width: 70 },
    {
      title: '操作',
      key: 'actions',
      width: 170,
      render: (_, s) => (
        <Space size={0}>
          <Button
            type="link"
            size="small"
            icon={<CopyOutlined />}
            onClick={async () => {
              if (await copyText(s.content)) message.success('已复制原文（变量没有替换）');
            }}
          >
            复制
          </Button>
          {canWrite && (
            <Button type="link" size="small" onClick={() => setEditing(s)}>
              编辑
            </Button>
          )}
          {canWrite && (
            <Button
              type="link"
              size="small"
              danger
              onClick={() =>
                modal.confirm({
                  title: `删除话术「${s.title}」？`,
                  okText: '删除',
                  okButtonProps: { danger: true },
                  onOk: () => remove.mutateAsync(s.id),
                })
              }
            >
              删除
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="话术库"
      extra={
        canWrite && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
            新增话术
          </Button>
        )
      }
    >
      <Typography.Paragraph type="secondary">
        在订阅、客户、订单页面点「话术」，会自动把客户称呼、套餐、到期日等填进去，一键复制到微信。
        话术里用 {'{客户称呼}'} 这样的写法插入变量。
      </Typography.Paragraph>
      <Segmented<ScriptCategory | 'all'>
        value={category}
        onChange={setCategory}
        style={{ marginBottom: 16, maxWidth: '100%', overflowX: 'auto' }}
        options={[
          { value: 'all', label: `全部 ${scripts.data?.length ?? 0}` },
          ...SCRIPT_CATEGORIES.map((c) => ({
            value: c.value,
            label: `${c.label} ${counts.get(c.value) ?? 0}`,
          })),
        ]}
      />
      <Table<Script>
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={scripts.isFetching}
        pagination={false}
        scroll={{ x: 760 }}
      />
      {editing && (
        <ScriptFormModal
          script={editing === 'new' ? null : editing}
          defaultCategory={category === 'all' ? 'renewal' : category}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

interface ScriptForm {
  category: ScriptCategory;
  title: string;
  content: string;
  sortOrder?: number;
}

function ScriptFormModal({
  script,
  defaultCategory,
  onClose,
}: {
  script: Script | null;
  defaultCategory: ScriptCategory;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<ScriptForm>();
  const content = Form.useWatch('content', form) ?? '';
  const textRef = useRef<TextAreaRef>(null);
  const save = useMutation({
    mutationFn: (v: ScriptForm) =>
      script
        ? unwrap(api.PATCH('/api/scripts/{id}', { params: { path: { id: script.id } }, body: v }))
        : unwrap(api.POST('/api/scripts', { body: v })),
    onSuccess: () => {
      message.success('已保存');
      void queryClient.invalidateQueries({ queryKey: ['scripts'] });
      onClose();
    },
  });

  /** 在光标处插入变量 */
  const insert = (key: string) => {
    const el = textRef.current?.resizableTextArea?.textArea;
    const token = `{${key}}`;
    const current: string = form.getFieldValue('content') ?? '';
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    form.setFieldValue('content', current.slice(0, start) + token + current.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <Modal
      open
      title={script ? '编辑话术' : '新增话术'}
      okText="保存"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
      width={640}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={
          script
            ? {
                category: script.category as ScriptCategory,
                title: script.title,
                content: script.content,
                sortOrder: script.sortOrder,
              }
            : { category: defaultCategory, sortOrder: 0 }
        }
        onFinish={(v) => save.mutate(v)}
      >
        <Space size={12} style={{ display: 'flex' }} wrap>
          <Form.Item name="category" label="分类" rules={[{ required: true }]}>
            <Select
              style={{ width: 140 }}
              options={SCRIPT_CATEGORIES.map((c) => ({ value: c.value, label: c.label }))}
            />
          </Form.Item>
          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, message: '请输入标题' }]}
            style={{ flex: 1, minWidth: 200 }}
          >
            <Input maxLength={40} placeholder="例如：到期前 3 天提醒" />
          </Form.Item>
          <Form.Item name="sortOrder" label="排序" tooltip="同一分类里小的排前面">
            <InputNumber min={0} max={9999} style={{ width: 90 }} />
          </Form.Item>
        </Space>
        <Form.Item label="插入变量" style={{ marginBottom: 8 }}>
          <Space size={[4, 4]} wrap>
            {SCRIPT_VARIABLES.map((v) => (
              <Tag
                key={v.key}
                color="blue"
                style={{ cursor: 'pointer' }}
                onClick={() => insert(v.key)}
              >
                {`{${v.key}}`}
              </Tag>
            ))}
          </Space>
        </Form.Item>
        <Form.Item
          name="content"
          label="内容"
          rules={[{ required: true, message: '请输入话术内容' }]}
        >
          <Input.TextArea ref={textRef} rows={6} maxLength={2000} showCount />
        </Form.Item>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          预览（用示例客户信息）
        </Typography.Text>
        <div className="script-card" style={{ marginTop: 4 }}>
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
            {content ? renderScript(content, EXAMPLE_VARS) : '—'}
          </Typography.Paragraph>
        </div>
      </Form>
    </Modal>
  );
}
