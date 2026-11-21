import type { ReactNode } from 'react';
import { Alert, Button, Card, List, Space, Tag, Typography } from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  InfoCircleFilled,
  ReloadOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { api, unwrap, type Schemas } from '../../api/client';
import { formatTime } from '../../components/format';

type Status = Schemas['ReadinessItemDto']['status'];

const STATUS: Record<Status, { icon: ReactNode; tag: string; color: string }> = {
  danger: {
    icon: <CloseCircleFilled style={{ color: '#ff4d4f' }} />,
    tag: '上线前必须处理',
    color: 'red',
  },
  warn: {
    icon: <ExclamationCircleFilled style={{ color: '#faad14' }} />,
    tag: '建议处理',
    color: 'orange',
  },
  info: { icon: <InfoCircleFilled style={{ color: '#1677ff' }} />, tag: '提示', color: 'blue' },
  ok: { icon: <CheckCircleFilled style={{ color: '#52c41a' }} />, tag: '已就绪', color: 'green' },
};

/** 上线检查：密钥、对外地址、两步验证、模拟收款通道、自动备份、接口文档 */
export function ReadinessPage() {
  const check = useQuery({
    queryKey: ['readiness'],
    queryFn: () => unwrap(api.GET('/api/system/readiness')),
  });
  const items = check.data?.items ?? [];
  const danger = items.filter((i) => i.status === 'danger').length;
  const warn = items.filter((i) => i.status === 'warn').length;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%', maxWidth: 860 }}>
      <Card
        title="上线检查"
        loading={check.isLoading}
        extra={
          <Button
            icon={<ReloadOutlined />}
            loading={check.isFetching}
            onClick={() => void check.refetch()}
          >
            重新检查
          </Button>
        }
      >
        {check.data && (
          <Alert
            type={danger ? 'error' : warn ? 'warning' : 'success'}
            showIcon
            style={{ marginBottom: 16 }}
            message={
              danger
                ? `有 ${danger} 项上线前必须处理${warn ? `，${warn} 项建议处理` : ''}`
                : warn
                  ? `没有必须处理的项，${warn} 项建议处理`
                  : '全部就绪'
            }
            description={
              <>
                {'本机试用时出现「必须处理」是正常的；搬到云服务器正式使用前，这里应该全部变绿（「提示」可以不管）。' +
                  '怎么改见仓库里的 docs/deploy.md。'}
                检查时间 {formatTime(check.data.checkedAt)}。
              </>
            }
          />
        )}
        <List
          itemLayout="horizontal"
          dataSource={items}
          renderItem={(i) => (
            <List.Item>
              <List.Item.Meta
                avatar={<span style={{ fontSize: 20 }}>{STATUS[i.status].icon}</span>}
                title={
                  <Space size={8} wrap>
                    <span>{i.title}</span>
                    <Tag color={STATUS[i.status].color} bordered={false}>
                      {STATUS[i.status].tag}
                    </Tag>
                  </Space>
                }
                description={
                  <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
                    {i.detail}
                  </Typography.Paragraph>
                }
              />
            </List.Item>
          )}
        />
      </Card>
    </Space>
  );
}
