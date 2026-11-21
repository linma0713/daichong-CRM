import { useState } from 'react';
import { Link } from 'react-router';
import {
  Alert,
  App,
  Button,
  DatePicker,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Typography,
  type TableColumnsType,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Dayjs } from 'dayjs';
import {
  STATEMENT_STATUSES,
  STATEMENT_STATUS_LABELS,
  formatCents,
  type StatementStatus,
} from '@crm/shared';
import { api, unwrap, type QueryOf, type Schemas } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { AgentLink, AgentSelect, PayableText, StatementStatusTag } from '../../components/business';
import { beijingToday, formatTime } from '../../components/format';

type Statement = Schemas['StatementDto'];
type Filters = QueryOf<'/api/commission-statements'> & { page: number; pageSize: number };

/** 月度对账单列表：佣金页和代理详情共用（传 agentId 时只看这个代理） */
export function StatementsTab({ agentId }: { agentId?: string }) {
  const { can } = useAuth();
  const [filters, setFilters] = useState<Filters>({ page: 1, pageSize: 20, agentId });
  const [generating, setGenerating] = useState(false);
  const list = useQuery({
    queryKey: ['commission-statements', filters],
    queryFn: () => unwrap(api.GET('/api/commission-statements', { params: { query: filters } })),
    placeholderData: keepPreviousData,
  });

  const columns: TableColumnsType<Statement> = [
    {
      title: '对账单',
      key: 'code',
      render: (_, s) => (
        <Space direction="vertical" size={0}>
          <Link to={`/commissions/statements/${s.id}`}>{s.code}</Link>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {s.month} 月
          </Typography.Text>
        </Space>
      ),
    },
    ...(agentId
      ? []
      : [
          {
            title: '代理',
            key: 'agent',
            render: (_: unknown, s: Statement) => <AgentLink agent={s.agent} />,
          },
        ]),
    {
      title: '佣金合计',
      key: 'commission',
      align: 'right',
      render: (_, s) => (
        <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
          <span style={{ whiteSpace: 'nowrap' }}>{formatCents(s.commissionCents)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {s.commissionCount} 条明细
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '代收抵扣',
      key: 'collected',
      align: 'right',
      render: (_, s) =>
        s.collectedCents ? (
          <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
            <span style={{ whiteSpace: 'nowrap' }}>− {formatCents(s.collectedCents)}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {s.paymentCount} 笔
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: '应付代理',
      key: 'payable',
      align: 'right',
      render: (_, s) => <PayableText cents={s.payableCents} strong />,
    },
    { title: '状态', key: 'status', render: (_, s) => <StatementStatusTag status={s.status} /> },
    {
      title: '时间',
      key: 'time',
      render: (_, s) => (
        <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {s.status === 'PAID'
            ? `结清 ${formatTime(s.paidAt)}`
            : s.status === 'CONFIRMED'
              ? `确认 ${formatTime(s.confirmedAt)}`
              : s.status === 'CANCELLED'
                ? `作废 ${formatTime(s.cancelledAt)}`
                : `收录到 ${formatTime(s.cutoffAt)}`}
        </Typography.Text>
      ),
    },
  ];

  return (
    <>
      <div className="page-toolbar">
        <div className="page-toolbar-filters">
          {!agentId && (
            <AgentSelect
              placeholder="代理"
              allowDisabled
              value={filters.agentId ?? null}
              style={{ width: 180 }}
              onChange={(id) => setFilters((f) => ({ ...f, page: 1, agentId: id ?? undefined }))}
            />
          )}
          <Select
            placeholder="状态"
            allowClear
            style={{ width: 120 }}
            options={STATEMENT_STATUSES.map((s) => ({
              value: s,
              label: STATEMENT_STATUS_LABELS[s],
            }))}
            onChange={(status?: StatementStatus) => setFilters((f) => ({ ...f, page: 1, status }))}
          />
          <DatePicker
            picker="month"
            placeholder="月份"
            style={{ width: 120 }}
            onChange={(d: Dayjs | null) =>
              setFilters((f) => ({ ...f, page: 1, month: d ? d.format('YYYY-MM') : undefined }))
            }
          />
          <Input.Search
            placeholder="对账单编号"
            allowClear
            style={{ width: 160 }}
            onSearch={(keyword) =>
              setFilters((f) => ({ ...f, page: 1, keyword: keyword || undefined }))
            }
          />
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void list.refetch()}>
            刷新
          </Button>
          {can('commission:settle') && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setGenerating(true)}>
              生成对账单
            </Button>
          )}
        </Space>
      </div>
      <Table<Statement>
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={list.data?.items}
        loading={list.isFetching}
        scroll={{ x: 760 }}
        locale={{ emptyText: '还没有对账单：每月 1 号自动给上个月出单，也可以手动生成' }}
        pagination={{
          current: filters.page,
          pageSize: filters.pageSize,
          total: list.data?.total,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 张`,
          onChange: (page, pageSize) => setFilters((f) => ({ ...f, page, pageSize })),
        }}
      />
      {generating && <GenerateModal agentId={agentId} onClose={() => setGenerating(false)} />}
    </>
  );
}

interface GenerateForm {
  month: Dayjs;
  agentId?: string | null;
}

function GenerateModal({ agentId, onClose }: { agentId?: string; onClose: () => void }) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<GenerateForm>();
  const generate = useMutation({
    mutationFn: (v: GenerateForm) =>
      unwrap(
        api.POST('/api/commission-statements/generate', {
          body: { month: v.month.format('YYYY-MM'), agentId: v.agentId ?? undefined },
        }),
      ),
    onSuccess: (r) => {
      const parts = [
        r.created ? `新生成 ${r.created} 张` : null,
        r.refreshed ? `${r.refreshed} 张草稿补进了新明细` : null,
        r.skipped ? `${r.skipped} 个代理这个月已确认，新明细留到下个月` : null,
      ].filter(Boolean);
      if (parts.length) message.success(parts.join('；'));
      else message.info('没有需要结算的佣金或代收款');
      void queryClient.invalidateQueries({ queryKey: ['commission-statements'] });
      void queryClient.invalidateQueries({ queryKey: ['commissions'] });
      onClose();
    },
  });
  const today = beijingToday();
  return (
    <Modal
      open
      title="生成佣金对账单"
      okText="生成"
      confirmLoading={generate.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="每月 1 号会自动给上个月出单，一般不用手动生成"
        description="收录截止到月底（当月就是现在）之前变成「可结算」的佣金（含退款扣回），加上代理代收、还没抵扣的款。这个月已有草稿的会补进新明细。"
      />
      <Form<GenerateForm>
        form={form}
        layout="vertical"
        initialValues={{ month: today, agentId: agentId ?? null }}
        onFinish={(v) => generate.mutate(v)}
      >
        <Form.Item
          name="month"
          label="对账月份"
          rules={[{ required: true, message: '请选择月份' }]}
        >
          <DatePicker
            picker="month"
            allowClear={false}
            style={{ width: '100%' }}
            disabledDate={(d) => d.isAfter(today, 'month')}
          />
        </Form.Item>
        {!agentId && (
          <Form.Item name="agentId" label="代理" extra="不选就是所有有待结算佣金的代理">
            <AgentSelect placeholder="全部代理" allowDisabled allowClear />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}
