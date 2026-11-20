import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FULFILLMENT_TYPE_LABELS, FULFILLMENT_TYPES, formatCents, termLabel } from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { useBusinessSettings, usePlans, useProducts } from '../../api/queries';
import { useAuth } from '../../auth/AuthProvider';
import { FulfillmentTag, Money } from '../../components/business';

type Plan = Schemas['PlanDto'];
type Product = Schemas['ProductDto'];

const TERM_OPTIONS = [1, 3, 6, 12].map((m) => ({ value: m, label: termLabel(m) }));

/** 元 ⇄ 分 */
const toCents = (yuan: number) => Math.round(yuan * 100);
const toYuan = (cents: number) => cents / 100;

export function CatalogPage() {
  const { can } = useAuth();
  const canWrite = can('product:write');
  const queryClient = useQueryClient();
  const plans = usePlans();
  const products = useProducts();
  const settings = useBusinessSettings();
  const [editingPlan, setEditingPlan] = useState<Plan | 'new' | null>(null);
  const [editingProduct, setEditingProduct] = useState<Product | 'new' | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['plans'] });
    void queryClient.invalidateQueries({ queryKey: ['products'] });
  };

  const planColumns: TableColumnsType<Plan> = [
    {
      title: '套餐',
      key: 'name',
      render: (_, p) => (
        <Space>
          <Typography.Text strong>{p.name}</Typography.Text>
          <Typography.Text type="secondary">{p.code}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '官方月费',
      key: 'usd',
      render: (_, p) => formatCents(p.upstreamMonthlyUsdCents, '$'),
    },
    {
      title: '折合人民币 / 月',
      key: 'cny',
      render: (_, p) =>
        settings.data
          ? formatCents(Math.round(p.upstreamMonthlyUsdCents * settings.data.exchangeRate))
          : '—',
    },
    {
      title: '状态',
      key: 'active',
      render: (_, p) => (p.active ? <Tag color="green">在售</Tag> : <Tag>已停售</Tag>),
    },
  ];
  if (canWrite) {
    planColumns.push({
      title: '操作',
      key: 'actions',
      render: (_, p) => (
        <Button type="link" size="small" onClick={() => setEditingPlan(p)}>
          编辑
        </Button>
      ),
    });
  }

  const productColumns: TableColumnsType<Product> = [
    { title: '商品', dataIndex: 'name', key: 'name' },
    {
      title: '履约方式',
      key: 'type',
      render: (_, p) => <FulfillmentTag type={p.fulfillmentType} />,
    },
    { title: '售价', key: 'price', render: (_, p) => <Money cents={p.priceCents} strong /> },
    {
      title: '估算成本',
      key: 'cost',
      render: (_, p) => (
        <Typography.Text type="secondary">{formatCents(p.estCostCents)}</Typography.Text>
      ),
    },
    {
      title: '估算毛利',
      key: 'margin',
      render: (_, p) => (
        <Typography.Text type={p.estMarginCents < 0 ? 'danger' : 'success'}>
          {formatCents(p.estMarginCents)}
          {p.priceCents > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}>
              {Math.round((p.estMarginCents / p.priceCents) * 100)}%
            </Typography.Text>
          )}
        </Typography.Text>
      ),
    },
    {
      title: '质保价',
      key: 'warranty',
      render: (_, p) =>
        p.warrantyPriceCents === null ? (
          <Typography.Text type="secondary">不提供</Typography.Text>
        ) : (
          <Money cents={p.warrantyPriceCents} />
        ),
    },
    {
      title: '状态',
      key: 'active',
      render: (_, p) => (p.active ? <Tag color="green">在售</Tag> : <Tag>已下架</Tag>),
    },
  ];
  if (canWrite) {
    productColumns.push({
      title: '操作',
      key: 'actions',
      render: (_, p) => (
        <Button type="link" size="small" onClick={() => setEditingProduct(p)}>
          改价 / 上下架
        </Button>
      ),
    });
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="可售商品"
        extra={
          canWrite && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditingProduct('new')}>
              新增商品
            </Button>
          )
        }
      >
        <Typography.Paragraph type="secondary">
          商品 = 套餐 × 时长 × 履约方式。估算成本 = 官方月费 × 月数 × 汇率（
          {settings.data?.exchangeRate ?? '—'}），不含付款手续费；改价只影响之后的订单。
        </Typography.Paragraph>
        <Table<Product>
          rowKey="id"
          columns={productColumns}
          dataSource={products.data}
          loading={products.isFetching}
          pagination={false}
          scroll={{ x: 760 }}
          locale={{ emptyText: canWrite ? '还没有商品，点右上角「新增商品」' : '还没有上架商品' }}
        />
      </Card>
      <Card
        title="套餐"
        extra={
          canWrite && (
            <Button icon={<PlusOutlined />} onClick={() => setEditingPlan('new')}>
              新增套餐
            </Button>
          )
        }
      >
        <Table<Plan>
          rowKey="id"
          columns={planColumns}
          dataSource={plans.data}
          loading={plans.isFetching}
          pagination={false}
          scroll={{ x: 560 }}
        />
      </Card>
      {editingPlan && (
        <PlanModal
          plan={editingPlan === 'new' ? null : editingPlan}
          onClose={() => setEditingPlan(null)}
          onSaved={invalidate}
        />
      )}
      {editingProduct && (
        <ProductModal
          product={editingProduct === 'new' ? null : editingProduct}
          plans={plans.data ?? []}
          exchangeRate={settings.data?.exchangeRate ?? 7.2}
          onClose={() => setEditingProduct(null)}
          onSaved={invalidate}
        />
      )}
    </Space>
  );
}

interface PlanForm {
  code: string;
  name: string;
  usd: number;
  sort?: number;
  active: boolean;
}

function PlanModal({
  plan,
  onClose,
  onSaved,
}: {
  plan: Plan | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<PlanForm>();
  const save = useMutation({
    mutationFn: (v: PlanForm) => {
      const body = {
        name: v.name,
        upstreamMonthlyUsdCents: toCents(v.usd),
        sort: v.sort,
        active: v.active,
      };
      return plan
        ? unwrap(api.PATCH('/api/plans/{id}', { params: { path: { id: plan.id } }, body }))
        : unwrap(api.POST('/api/plans', { body: { ...body, code: v.code } }));
    },
    onSuccess: () => {
      message.success('已保存');
      onSaved();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={plan ? `编辑套餐：${plan.name}` : '新增套餐'}
      okText="保存"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Form<PlanForm>
        form={form}
        layout="vertical"
        initialValues={
          plan
            ? { ...plan, usd: toYuan(plan.upstreamMonthlyUsdCents) }
            : { active: true, sort: 100 }
        }
        onFinish={(v) => save.mutate(v)}
      >
        <Form.Item
          name="code"
          label="编码"
          rules={[
            { required: true, message: '请输入编码' },
            {
              pattern: /^[A-Z][A-Z0-9_]{1,31}$/,
              message: '大写字母开头，2–32 位大写字母、数字或下划线',
            },
          ]}
          extra={plan ? '编码创建后不能修改' : '例如 MAX、MAX_20X'}
        >
          <Input disabled={!!plan} />
        </Form.Item>
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
          <Input maxLength={32} />
        </Form.Item>
        <Form.Item
          name="usd"
          label="官方月费（美元）"
          rules={[{ required: true, message: '请输入官方月费' }]}
          extra="按官方当前实际价格填写，用于估算成本和毛利"
        >
          <InputNumber min={0} max={10000} precision={2} prefix="$" style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="sort" label="排序" extra="数字小的排前面">
          <InputNumber style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="active" label="在售" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}

interface ProductForm {
  planId: string;
  termMonths: number;
  fulfillmentType: Schemas['FulfillmentType'];
  price: number;
  /** 质保价（元）；空 = 不提供质保 */
  warranty?: number | null;
  active: boolean;
}

const warrantyCents = (v: number | null | undefined) =>
  v === undefined || v === null ? null : toCents(v);

function ProductModal({
  product,
  plans,
  exchangeRate,
  onClose,
  onSaved,
}: {
  product: Product | null;
  plans: Plan[];
  exchangeRate: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<ProductForm>();
  const planId = Form.useWatch('planId', form);
  const termMonths = Form.useWatch('termMonths', form);
  const price = Form.useWatch('price', form);
  const plan = plans.find((p) => p.id === (product?.planId ?? planId));
  const months = product?.termMonths ?? termMonths;
  const cost =
    plan && months ? Math.round(plan.upstreamMonthlyUsdCents * months * exchangeRate) : null;

  const save = useMutation({
    mutationFn: (v: ProductForm) =>
      product
        ? unwrap(
            api.PATCH('/api/products/{id}', {
              params: { path: { id: product.id } },
              body: {
                priceCents: toCents(v.price),
                warrantyPriceCents: warrantyCents(v.warranty),
                active: v.active,
              },
            }),
          )
        : unwrap(
            api.POST('/api/products', {
              body: {
                planId: v.planId,
                termMonths: v.termMonths,
                fulfillmentType: v.fulfillmentType,
                priceCents: toCents(v.price),
                warrantyPriceCents: warrantyCents(v.warranty),
                active: v.active,
              },
            }),
          ),
    onSuccess: () => {
      message.success('已保存');
      onSaved();
      onClose();
    },
  });

  return (
    <Modal
      open
      title={product ? `修改商品：${product.name}` : '新增商品'}
      okText="保存"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Form<ProductForm>
        form={form}
        layout="vertical"
        initialValues={
          product
            ? {
                ...product,
                price: toYuan(product.priceCents),
                warranty:
                  product.warrantyPriceCents === null ? null : toYuan(product.warrantyPriceCents),
              }
            : { termMonths: 1, fulfillmentType: 'RECHARGE', active: true }
        }
        onFinish={(v) => save.mutate(v)}
      >
        <Form.Item name="planId" label="套餐" rules={[{ required: true, message: '请选择套餐' }]}>
          <Select
            disabled={!!product}
            options={plans
              .filter((p) => p.active || p.id === product?.planId)
              .map((p) => ({ value: p.id, label: p.name }))}
          />
        </Form.Item>
        <Space size={16} style={{ display: 'flex' }}>
          <Form.Item name="termMonths" label="时长" rules={[{ required: true }]}>
            <Select disabled={!!product} options={TERM_OPTIONS} style={{ width: 140 }} />
          </Form.Item>
          <Form.Item name="fulfillmentType" label="履约方式" rules={[{ required: true }]}>
            <Select
              disabled={!!product}
              style={{ width: 140 }}
              options={FULFILLMENT_TYPES.map((t) => ({
                value: t,
                label: FULFILLMENT_TYPE_LABELS[t],
              }))}
            />
          </Form.Item>
        </Space>
        <Form.Item
          name="price"
          label="售价（元）"
          rules={[{ required: true, message: '请输入售价' }]}
        >
          <InputNumber min={0} max={1000000} precision={2} prefix="¥" style={{ width: '100%' }} />
        </Form.Item>
        {cost !== null && (
          <Alert
            type={price !== undefined && toCents(price ?? 0) < cost ? 'warning' : 'info'}
            showIcon
            style={{ marginBottom: 16 }}
            message={
              <>
                估算成本 {formatCents(cost)}
                {price !== undefined && price !== null && (
                  <>，估算毛利 {formatCents(toCents(price) - cost)}</>
                )}
              </>
            }
          />
        )}
        <Form.Item
          name="warranty"
          label="质保价（元）"
          extra="客户下单时可以加购：服务期内包换 + 按剩余天数退款，质保费不退。留空 = 这个商品不提供质保"
        >
          <InputNumber min={0} max={1000000} precision={2} prefix="¥" style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="active" label="在售" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}
