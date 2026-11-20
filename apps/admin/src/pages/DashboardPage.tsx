import { Card, Col, Descriptions, Row, Space, Steps, Tag, Typography } from 'antd';
import { DATA_SCOPE_LABELS, type DataScope } from '@crm/shared';
import { useAuth } from '../auth/AuthProvider';

/** 开发路线，和设计画布 ⑦ 分期保持一致 */
const ROADMAP = [
  {
    title: 'M0 底座',
    description: '员工账号、角色权限、小组、操作日志、一键本地启动',
  },
  {
    title: 'M1 主链路',
    description: '客户、商品与套餐、订单与收款、开通 / 发号任务、订阅与到期提醒',
  },
  {
    title: 'M2 经营闭环',
    description: '付款资源与成品号库存、单笔毛利、售后与质保、数据看板',
  },
  { title: 'M3 代理', description: '代理录单、两级佣金、冻结期与月度对账' },
  { title: 'M4 多端与上云', description: '员工手机端（小程序 / App）、云端部署与备份' },
];

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 18) return '下午好';
  return '晚上好';
}

export function DashboardPage() {
  const { profile } = useAuth();
  if (!profile) return null;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          {greeting()}，{profile.displayName}
        </Typography.Title>
        <Descriptions column={{ xs: 1, sm: 2 }} size="small">
          <Descriptions.Item label="角色">
            <Space size={4} wrap>
              {profile.roles.map((r) => (
                <Tag key={r.id} color="blue">
                  {r.name}
                </Tag>
              ))}
              {profile.roles.length === 0 && (
                <Typography.Text type="secondary">未分配</Typography.Text>
              )}
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="数据范围">
            {DATA_SCOPE_LABELS[profile.dataScope as DataScope]}
          </Descriptions.Item>
        </Descriptions>
      </Card>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card title="开发进度">
            <Steps direction="vertical" size="small" current={0} items={ROADMAP} />
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card title="现在可以做什么">
            <Typography.Paragraph>
              {'底座已经可以使用：管理员在「系统管理」里开通员工账号、分配角色和小组；' +
                '员工首次登录会被要求修改初始密码；所有新增、修改、删除操作都会记录在「操作日志」里。'}
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              客户、订单、开通任务等业务菜单会在 M1 上线，角色里已经可以提前勾选对应权限。
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
