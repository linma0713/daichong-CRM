import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  App,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CUSTOMER_SOURCES, type CustomerSource } from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { useStaffOptions } from '../../api/queries';
import { useAuth } from '../../auth/AuthProvider';
import { CustomerSelect } from '../../components/business';
import { formatTime } from '../../components/format';

type Customer = Schemas['CustomerDto'];

const SOURCE_LABELS = Object.fromEntries(CUSTOMER_SOURCES.map((s) => [s.value, s.label]));

interface Filters {
  page: number;
  pageSize: number;
  keyword?: string;
  source?: CustomerSource;
  ownerId?: string;
}

export function CustomersPage() {
  const { can, profile } = useAuth();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<Filters>({ page: 1, pageSize: 20 });
  const [creating, setCreating] = useState(false);
  const staff = useStaffOptions();
  const customers = useQuery({
    queryKey: ['customers', filters],
    queryFn: () => unwrap(api.GET('/api/customers', { params: { query: filters } })),
    placeholderData: keepPreviousData,
  });

  const columns: TableColumnsType<Customer> = [
    {
      title: '客户',
      key: 'name',
      render: (_, c) => (
        <Space direction="vertical" size={0}>
          <Link to={`/customers/${c.id}`}>
            <Typography.Text strong>{c.name}</Typography.Text>
          </Link>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {c.code}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '联系方式',
      key: 'contact',
      render: (_, c) => (
        <Space direction="vertical" size={0} style={{ fontSize: 12 }}>
          {c.wechat && <span>微信：{c.wechat}</span>}
          {c.telegram && <span>TG：{c.telegram}</span>}
          {c.phone && <span>手机：{c.phone}</span>}
          {c.email && <span>邮箱：{c.email}</span>}
          {!c.wechat && !c.telegram && !c.phone && !c.email && '—'}
        </Space>
      ),
    },
    {
      title: '来源',
      key: 'source',
      render: (_, c) => (
        <Space direction="vertical" size={0}>
          <span>{SOURCE_LABELS[c.source] ?? c.source}</span>
          {c.referrer && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              推荐人：{c.referrer.name}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '标签',
      key: 'tags',
      render: (_, c) =>
        c.tags.length ? (
          <Space size={4} wrap>
            {c.tags.map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
          </Space>
        ) : (
          '—'
        ),
    },
    {
      title: '服务中订阅',
      key: 'subs',
      render: (_, c) =>
        c.activeSubscriptionCount > 0 ? (
          <Space direction="vertical" size={0}>
            <span>{c.activeSubscriptionCount} 个</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              最近到期 {formatTime(c.nextExpiryAt).slice(0, 10)}
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">无</Typography.Text>
        ),
    },
    { title: '负责人', key: 'owner', render: (_, c) => c.owner.displayName },
    { title: '录入时间', key: 'createdAt', render: (_, c) => formatTime(c.createdAt) },
  ];

  return (
    <Card
      title="客户"
      extra={
        can('customer:write') && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            新增客户
          </Button>
        )
      }
    >
      <div className="page-toolbar">
        <div className="page-toolbar-filters">
          <Input.Search
            placeholder="编号、称呼、微信、TG、手机号"
            allowClear
            style={{ width: 240 }}
            onSearch={(keyword) =>
              setFilters((f) => ({ ...f, page: 1, keyword: keyword || undefined }))
            }
          />
          <Select
            placeholder="来源"
            allowClear
            style={{ width: 120 }}
            options={CUSTOMER_SOURCES.map((s) => ({ value: s.value, label: s.label }))}
            onChange={(source?: CustomerSource) => setFilters((f) => ({ ...f, page: 1, source }))}
          />
          {profile?.dataScope !== 'SELF' && (
            <Select
              placeholder="负责人"
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: 140 }}
              options={(staff.data ?? []).map((s) => ({ value: s.id, label: s.displayName }))}
              onChange={(ownerId?: string) => setFilters((f) => ({ ...f, page: 1, ownerId }))}
            />
          )}
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void customers.refetch()}>
          刷新
        </Button>
      </div>
      <Table<Customer>
        rowKey="id"
        columns={columns}
        dataSource={customers.data?.items}
        loading={customers.isFetching}
        scroll={{ x: 960 }}
        pagination={{
          current: filters.page,
          pageSize: filters.pageSize,
          total: customers.data?.total,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 位客户`,
          onChange: (page, pageSize) => setFilters((f) => ({ ...f, page, pageSize })),
        }}
      />
      {creating && (
        <CustomerFormModal
          customer={null}
          onClose={() => setCreating(false)}
          onSaved={(c) => navigate(`/customers/${c.id}`)}
        />
      )}
    </Card>
  );
}

interface CustomerForm {
  name: string;
  wechat?: string;
  telegram?: string;
  phone?: string;
  email?: string;
  source: CustomerSource;
  referrerId?: string | null;
  tags: string[];
  remark?: string;
  ownerId?: string;
}

export function CustomerFormModal({
  customer,
  onClose,
  onSaved,
}: {
  customer: Schemas['CustomerDto'] | null;
  onClose: () => void;
  onSaved: (c: Schemas['CustomerDto']) => void;
}) {
  const { message } = App.useApp();
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const staff = useStaffOptions();
  const [form] = Form.useForm<CustomerForm>();
  const source = Form.useWatch('source', form);
  const isNew = customer === null;
  // 指定其他负责人需要「全部数据」或同组范围
  const ownerOptions = (staff.data ?? [])
    .filter(
      (s) =>
        profile?.dataScope === 'ALL' ||
        s.id === profile?.id ||
        (profile?.dataScope === 'TEAM' && profile.teamId && s.teamId === profile.teamId),
    )
    .map((s) => ({ value: s.id, label: s.displayName }));

  const save = useMutation({
    mutationFn: (v: CustomerForm) => {
      const body = {
        name: v.name,
        wechat: v.wechat || null,
        telegram: v.telegram || null,
        phone: v.phone || null,
        email: v.email || null,
        source: v.source,
        referrerId: v.source === 'referral' ? (v.referrerId ?? null) : null,
        tags: v.tags,
        remark: v.remark || null,
      };
      return isNew
        ? unwrap(api.POST('/api/customers', { body: { ...body, ownerId: v.ownerId } }))
        : unwrap(api.PATCH('/api/customers/{id}', { params: { path: { id: customer.id } }, body }));
    },
    onSuccess: (c) => {
      message.success('已保存');
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      onSaved(c);
      onClose();
    },
  });

  return (
    <Modal
      open
      title={isNew ? '新增客户' : `编辑客户：${customer.name}`}
      okText="保存"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
      width={560}
    >
      <Form<CustomerForm>
        form={form}
        layout="vertical"
        initialValues={
          customer
            ? {
                ...customer,
                wechat: customer.wechat ?? undefined,
                telegram: customer.telegram ?? undefined,
                phone: customer.phone ?? undefined,
                email: customer.email ?? undefined,
                remark: customer.remark ?? undefined,
                source: customer.source as CustomerSource,
                referrerId: customer.referrer?.id ?? null,
              }
            : { source: 'organic', tags: [], ownerId: profile?.id }
        }
        onFinish={(v) => save.mutate(v)}
      >
        <Form.Item name="name" label="称呼" rules={[{ required: true, message: '请输入客户称呼' }]}>
          <Input maxLength={32} placeholder="例如：王先生" />
        </Form.Item>
        <Typography.Text
          type="secondary"
          style={{ display: 'block', marginBottom: 8, fontSize: 12 }}
        >
          联系方式至少填一个；同一个微信 / TG / 手机号 / 邮箱只能属于一个客户，避免重复跟进
        </Typography.Text>
        <Row gutter={12}>
          <Col xs={24} sm={12}>
            <Form.Item name="wechat" label="微信">
              <Input maxLength={64} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="telegram" label="Telegram">
              <Input maxLength={64} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="phone" label="手机">
              <Input maxLength={32} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item
              name="email"
              label="邮箱"
              rules={[{ type: 'email', message: '邮箱格式不正确' }]}
            >
              <Input />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="source" label="来源">
          <Select options={CUSTOMER_SOURCES.map((s) => ({ value: s.value, label: s.label }))} />
        </Form.Item>
        {source === 'referral' && (
          <Form.Item name="referrerId" label="推荐人">
            <CustomerSelect
              placeholder="搜索推荐这位客户的老客户"
              initialOption={
                customer?.referrer
                  ? {
                      value: customer.referrer.id,
                      label: `${customer.referrer.name}（${customer.referrer.code}）`,
                    }
                  : undefined
              }
            />
          </Form.Item>
        )}
        <Form.Item name="tags" label="标签">
          <Select mode="tags" placeholder="输入后回车，例如：老客、大客户" maxCount={10} />
        </Form.Item>
        <Form.Item name="remark" label="备注">
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
        {isNew && ownerOptions.length > 1 && (
          <Form.Item name="ownerId" label="负责人">
            <Select options={ownerOptions} showSearch optionFilterProp="label" />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}
