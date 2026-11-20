import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
  Typography,
} from 'antd';
import { useMutation, useQuery } from '@tanstack/react-query';
import { formatCents, type OrderKind } from '@crm/shared';
import { api, unwrap } from '../../api/client';
import { useProducts } from '../../api/queries';
import { CustomerSelect, FulfillmentTag } from '../../components/business';
import { formatTime } from '../../components/format';

interface OrderForm {
  customerId?: string;
  kind: OrderKind;
  subscriptionId?: string;
  productId?: string;
  discount?: number;
  withWarranty?: boolean;
  accountEmail?: string;
  accountPassword?: string;
  remark?: string;
}

export function NewOrderPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [form] = Form.useForm<OrderForm>();
  const customerId = Form.useWatch('customerId', form);
  const kind = Form.useWatch('kind', form) ?? 'NEW';
  const subscriptionId = Form.useWatch('subscriptionId', form);
  const productId = Form.useWatch('productId', form);
  const discount = Form.useWatch('discount', form) ?? 0;
  const withWarranty = Form.useWatch('withWarranty', form) ?? false;

  const presetCustomerId = params.get('customerId') ?? undefined;
  const presetCustomer = useQuery({
    queryKey: ['customer', presetCustomerId],
    queryFn: () =>
      unwrap(api.GET('/api/customers/{id}', { params: { path: { id: presetCustomerId! } } })),
    enabled: !!presetCustomerId,
  });
  const products = useProducts(true);
  const subs = useQuery({
    queryKey: ['subscriptions', { customerId, pageSize: 100 }],
    queryFn: () =>
      unwrap(api.GET('/api/subscriptions', { params: { query: { customerId, pageSize: 100 } } })),
    enabled: !!customerId && kind === 'RENEWAL',
  });
  const renewable = (subs.data?.items ?? []).filter((s) => s.status !== 'CANCELLED');
  const sub = renewable.find((s) => s.id === subscriptionId);
  const productOptions = (products.data ?? []).filter(
    (p) => kind === 'NEW' || !sub || p.fulfillmentType === sub.fulfillmentType,
  );
  const product = products.data?.find((p) => p.id === productId);
  const warrantyCents =
    withWarranty && product?.warrantyPriceCents !== null ? (product?.warrantyPriceCents ?? 0) : 0;
  const amount = product ? product.priceCents - Math.round(discount * 100) + warrantyCents : null;
  const seamless =
    kind === 'RENEWAL' &&
    sub &&
    product &&
    sub.status === 'ACTIVE' &&
    sub.autoRenewOn &&
    product.planId === sub.planId;

  // 换了订阅后，如果已选商品的履约方式对不上就清掉
  useEffect(() => {
    if (sub && product && product.fulfillmentType !== sub.fulfillmentType) {
      form.setFieldValue('productId', undefined);
    }
  }, [sub, product, form]);

  const create = useMutation({
    mutationFn: (v: OrderForm) =>
      unwrap(
        api.POST('/api/orders', {
          body: {
            customerId: v.customerId!,
            kind: v.kind,
            productId: v.productId!,
            subscriptionId: v.kind === 'RENEWAL' ? v.subscriptionId : undefined,
            discountCents: Math.round((v.discount ?? 0) * 100),
            withWarranty: v.withWarranty && product?.warrantyPriceCents !== null ? true : undefined,
            accountEmail: v.kind === 'NEW' ? v.accountEmail || undefined : undefined,
            accountPassword: v.kind === 'NEW' ? v.accountPassword || undefined : undefined,
            remark: v.remark || undefined,
          },
        }),
      ),
    onSuccess: (o) => navigate(`/orders/${o.id}`, { replace: true }),
  });

  return (
    <Card title="录入订单" style={{ maxWidth: 760 }}>
      <Form<OrderForm>
        form={form}
        layout="vertical"
        initialValues={{
          customerId: presetCustomerId,
          kind: (params.get('kind') as OrderKind) ?? 'NEW',
          subscriptionId: params.get('subscriptionId') ?? undefined,
          discount: 0,
        }}
        onFinish={(v) => create.mutate(v)}
      >
        <Form.Item
          name="customerId"
          label="客户"
          rules={[{ required: true, message: '请选择客户' }]}
        >
          <CustomerSelect
            initialOption={
              presetCustomer.data
                ? {
                    value: presetCustomer.data.id,
                    label: `${presetCustomer.data.name}（${presetCustomer.data.code}）`,
                  }
                : undefined
            }
            onChange={() => form.setFieldValue('subscriptionId', undefined)}
          />
        </Form.Item>
        <Form.Item name="kind" label="类型">
          <Radio.Group
            optionType="button"
            options={[
              { value: 'NEW', label: '新购（开通新订阅）' },
              { value: 'RENEWAL', label: '续费（延长已有订阅）' },
            ]}
          />
        </Form.Item>
        {kind === 'RENEWAL' && (
          <Form.Item
            name="subscriptionId"
            label="续费哪个订阅"
            rules={[{ required: true, message: '请选择订阅' }]}
            extra={
              customerId && !subs.isFetching && renewable.length === 0
                ? '这位客户没有可以续费的订阅，请下新购订单'
                : undefined
            }
          >
            <Select
              placeholder={customerId ? '选择订阅' : '先选择客户'}
              disabled={!customerId}
              loading={subs.isFetching}
              options={renewable.map((s) => ({
                value: s.id,
                label: `${s.code} · ${s.planName} · ${s.account.email} · ${formatTime(s.endAt).slice(0, 10)} 到期`,
              }))}
            />
          </Form.Item>
        )}
        <Form.Item
          name="productId"
          label="商品"
          rules={[{ required: true, message: '请选择商品' }]}
        >
          <Select
            placeholder="选择商品"
            loading={products.isFetching}
            options={productOptions.map((p) => ({
              value: p.id,
              label: (
                <Space>
                  {p.name}
                  <Typography.Text type="secondary">{formatCents(p.priceCents)}</Typography.Text>
                </Space>
              ),
            }))}
            notFoundContent="没有在售商品，请先在「商品与套餐」里上架"
          />
        </Form.Item>
        {kind === 'NEW' && product?.fulfillmentType === 'RECHARGE' && (
          <>
            <Form.Item
              name="accountEmail"
              label="客户的 Claude 账号邮箱"
              rules={[
                { required: true, message: '代充订单要填写客户的 Claude 账号' },
                { type: 'email', message: '邮箱格式不正确' },
              ]}
            >
              <Input placeholder="充值到这个账号" autoComplete="off" />
            </Form.Item>
            <Form.Item
              name="accountPassword"
              label="账号密码"
              extra="加密保存，只有有权限的充值员能查看，每次查看都会记录。也可以之后再补。"
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          </>
        )}
        {kind === 'NEW' && product?.fulfillmentType === 'ACCOUNT' && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="成品号由充值员在开通时分配并录入账号信息。"
          />
        )}
        {seamless && (
          <Alert
            type="success"
            showIcon
            style={{ marginBottom: 16 }}
            message="同套餐续费，且上游自动续订开着：收齐款后会直接延长服务期，不需要充值员处理。"
          />
        )}
        <Form.Item name="discount" label="优惠（元）">
          <InputNumber
            min={0}
            max={product ? product.priceCents / 100 : undefined}
            precision={2}
            prefix="¥"
            style={{ width: 200 }}
          />
        </Form.Item>
        {product && product.warrantyPriceCents !== null && (
          <Form.Item
            name="withWarranty"
            valuePropName="checked"
            extra="服务期内包换 + 按剩余天数退款（质保费不退）"
          >
            <Checkbox>加购质保 +{formatCents(product.warrantyPriceCents)}</Checkbox>
          </Form.Item>
        )}
        <Form.Item name="remark" label="备注">
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
        {product && (
          <Descriptions bordered size="small" column={1} style={{ marginBottom: 24 }}>
            <Descriptions.Item label="商品">
              <Space>
                {product.name}
                <FulfillmentTag type={product.fulfillmentType} />
              </Space>
            </Descriptions.Item>
            {warrantyCents > 0 && (
              <Descriptions.Item label="质保">{formatCents(warrantyCents)}</Descriptions.Item>
            )}
            <Descriptions.Item label="应收">
              <Typography.Text strong style={{ fontSize: 18 }}>
                {formatCents(Math.max(amount ?? 0, 0))}
              </Typography.Text>
              {amount === 0 && (
                <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                  0 元订单保存后直接进入开通
                </Typography.Text>
              )}
            </Descriptions.Item>
          </Descriptions>
        )}
        <Space>
          <Button type="primary" htmlType="submit" loading={create.isPending}>
            保存订单
          </Button>
          <Button onClick={() => navigate(-1)}>取消</Button>
        </Space>
      </Form>
    </Card>
  );
}
