import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Input,
  Modal,
  Segmented,
  Space,
  Spin,
  Table,
  Typography,
  Upload,
} from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  DownloadOutlined,
  InboxOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, unwrap, type Schemas } from '../../api/client';
import { downloadCsv, parseTable } from '../../components/csv';
import { IMPORT_COLUMNS, mapTable, type ImportRow, type MappedTable } from './import';

type Result = Schemas['ImportResultDto'];
type RowResult = Result['rows'][number];
const MAX_ROWS = 500;

/** Excel 在中文 Windows 上另存的 CSV 默认是 GBK，先按 UTF-8 读，读不了再按 GB18030 */
async function decodeText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('gb18030').decode(buf);
  }
}

/**
 * 批量导入客户：选 Excel / CSV 或直接粘贴 → 先检查（不写库）→ 看结果 → 确认导入。
 * 有问题的行会跳过，可以下载下来改好再导。
 */
export function ImportCustomersModal({ onClose }: { onClose: () => void }) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [sourceName, setSourceName] = useState<string>();
  const [mapped, setMapped] = useState<MappedTable>();
  const [paste, setPaste] = useState('');
  const [reading, setReading] = useState(false);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [done, setDone] = useState<Result>();

  const check = useMutation({
    mutationFn: (rows: ImportRow[]) =>
      unwrap(api.POST('/api/customers/import', { body: { rows, dryRun: true } })),
    onSuccess: (r) => setOnlyErrors(r.valid < r.total && r.total > 10),
  });
  const commit = useMutation({
    mutationFn: (rows: ImportRow[]) =>
      unwrap(api.POST('/api/customers/import', { body: { rows } })),
    onSuccess: (r) => {
      setDone(r);
      setOnlyErrors(false);
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      message.success(`已导入 ${r.created} 位客户`);
    },
  });

  const reset = () => {
    setSourceName(undefined);
    setMapped(undefined);
    setDone(undefined);
    check.reset();
    commit.reset();
  };

  const load = (table: unknown[][], name: string) => {
    const m = mapTable(table);
    reset();
    setSourceName(name);
    setMapped(m);
    if (!m.error && m.rows.length <= MAX_ROWS) check.mutate(m.rows);
  };

  const readFile = async (file: File) => {
    setReading(true);
    try {
      if (/\.xlsx$/i.test(file.name)) {
        const { readSheet } = await import('read-excel-file/browser');
        load(await readSheet<string>(file, { parseNumber: (s) => s }), file.name);
      } else if (/\.(csv|tsv|txt)$/i.test(file.name)) {
        load(parseTable(await decodeText(file)), file.name);
      } else if (/\.xls$/i.test(file.name)) {
        message.error('不支持老的 .xls 格式，请在 Excel 里「另存为」.xlsx 再选');
      } else {
        message.error('只支持 Excel（.xlsx）和 CSV 文件');
      }
    } catch {
      message.error('读不了这个文件，请确认是 Excel（.xlsx）或 CSV');
    } finally {
      setReading(false);
    }
  };

  const result = done ?? check.data;
  const errorRows = result?.rows.filter((r) => r.status === 'error') ?? [];
  const tooMany = !!mapped && mapped.rows.length > MAX_ROWS;

  const downloadErrors = () => {
    if (!mapped || !result) return;
    const byLine = new Map(mapped.rows.map((r) => [r.line, r]));
    downloadCsv('customer-import-problems.csv', [
      [...IMPORT_COLUMNS.map((c) => c.title), '问题'],
      ...errorRows.map((e) => {
        const raw = byLine.get(e.row) ?? {};
        return [...IMPORT_COLUMNS.map((c) => raw[c.field]), e.errors.join('；')];
      }),
    ]);
  };

  const footer = done ? (
    <Button type="primary" onClick={onClose}>
      完成
    </Button>
  ) : (
    <Space>
      <Button onClick={onClose}>取消</Button>
      {mapped && (
        <Button
          type="primary"
          disabled={!check.data || check.data.valid === 0}
          loading={commit.isPending}
          onClick={() => mapped && commit.mutate(mapped.rows)}
        >
          {check.data ? `导入 ${check.data.valid} 位客户` : '导入'}
        </Button>
      )}
    </Space>
  );

  return (
    <Modal
      open
      title="批量导入客户"
      width={780}
      onCancel={onClose}
      footer={footer}
      maskClosable={false}
      destroyOnHidden
    >
      {!mapped ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="第一行是表头，按下面的列名填；一次最多 500 行"
            description="导入前会先检查一遍，不会直接写进系统。联系方式和已有客户重复的行会跳过，不会建重复客户。"
          />
          <Upload.Dragger
            accept=".xlsx,.csv,.tsv,.txt"
            showUploadList={false}
            disabled={reading}
            beforeUpload={(file) => {
              void readFile(file);
              return false;
            }}
          >
            <p className="ant-upload-drag-icon">
              {reading ? <LoadingOutlined /> : <InboxOutlined />}
            </p>
            <p className="ant-upload-text">点这里选 Excel / CSV 文件，或者把文件拖进来</p>
            <p className="ant-upload-hint">支持 .xlsx 和 .csv，只读第一个工作表</p>
          </Upload.Dragger>
          <div>
            <Typography.Text type="secondary">
              也可以在 Excel 里选中整张表（含表头）复制，粘贴到这里：
            </Typography.Text>
            <Input.TextArea
              rows={3}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder={'称呼\t微信\t手机\n王先生\twang_123\t13800138000'}
              style={{ marginTop: 6, fontFamily: 'monospace', fontSize: 12 }}
            />
            <Button
              style={{ marginTop: 8 }}
              disabled={!paste.trim()}
              onClick={() => load(parseTable(paste), '粘贴的表格')}
            >
              识别粘贴的内容
            </Button>
          </div>
          <div>
            <Space style={{ marginBottom: 6 }}>
              <Typography.Text strong>表格的列</Typography.Text>
              <Button
                size="small"
                type="link"
                icon={<DownloadOutlined />}
                onClick={() =>
                  downloadCsv('customer-import-template.csv', [IMPORT_COLUMNS.map((c) => c.title)])
                }
              >
                下载模板
              </Button>
            </Space>
            <Table
              size="small"
              rowKey="field"
              pagination={false}
              dataSource={IMPORT_COLUMNS}
              columns={[
                { title: '表头', dataIndex: 'title', width: 100 },
                {
                  title: '怎么填',
                  key: 'note',
                  render: (_, c) => (
                    <Space direction="vertical" size={0}>
                      {c.note && <span>{c.note}</span>}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        也认：{c.aliases.slice(0, 4).join('、')}
                      </Typography.Text>
                    </Space>
                  ),
                },
              ]}
            />
          </div>
        </Space>
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap size={[12, 4]}>
            <Typography.Text strong>{sourceName}</Typography.Text>
            {mapped.matched.length > 0 && (
              <Typography.Text type="secondary">
                识别到 {mapped.rows.length} 行 · 列：{mapped.matched.join('、')}
                {mapped.ignored.length > 0 && ` · 忽略：${mapped.ignored.join('、')}`}
              </Typography.Text>
            )}
            {!done && (
              <Button size="small" type="link" onClick={reset} style={{ padding: 0 }}>
                换一个文件
              </Button>
            )}
          </Space>
          {mapped.error && <Alert type="error" showIcon message={mapped.error} />}
          {tooMany && (
            <Alert
              type="error"
              showIcon
              message={`有 ${mapped.rows.length} 行，一次最多导入 ${MAX_ROWS} 行，请拆成几个文件分批导入`}
            />
          )}
          {check.isPending && (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Spin tip="正在检查…">
                <div style={{ height: 40 }} />
              </Spin>
            </div>
          )}
          {check.isError && <Alert type="error" showIcon message="检查失败，请看上方提示" />}
          {result && (
            <>
              <Alert
                type={done ? 'success' : errorRows.length ? 'warning' : 'success'}
                showIcon
                message={
                  done
                    ? `已导入 ${done.created} 位客户${errorRows.length ? `，${errorRows.length} 行有问题已跳过` : ''}`
                    : errorRows.length
                      ? `共 ${result.total} 行：${result.valid} 行可以导入，${errorRows.length} 行有问题，导入时会跳过`
                      : `共 ${result.total} 行，全部可以导入`
                }
                action={
                  errorRows.length > 0 && (
                    <Button size="small" icon={<DownloadOutlined />} onClick={downloadErrors}>
                      下载有问题的行
                    </Button>
                  )
                }
              />
              {errorRows.length > 0 && (
                <Segmented
                  value={onlyErrors ? 'err' : 'all'}
                  onChange={(v) => setOnlyErrors(v === 'err')}
                  options={[
                    { value: 'all', label: `全部 ${result.total}` },
                    { value: 'err', label: `有问题 ${errorRows.length}` },
                  ]}
                />
              )}
              <Table<RowResult>
                size="small"
                rowKey="row"
                dataSource={onlyErrors ? errorRows : result.rows}
                pagination={{ pageSize: 8, hideOnSinglePage: true, showSizeChanger: false }}
                columns={[
                  { title: '行号', dataIndex: 'row', width: 64 },
                  { title: '称呼', dataIndex: 'name', width: 140, ellipsis: true },
                  {
                    title: '负责人',
                    key: 'owner',
                    width: 96,
                    render: (_, r) => (r.status === 'ok' ? r.ownerName : '—'),
                  },
                  {
                    title: '结果',
                    key: 'status',
                    render: (_, r) =>
                      r.status === 'ok' ? (
                        <Typography.Text type="success">
                          <CheckCircleFilled /> {done ? '已导入' : '可以导入'}
                        </Typography.Text>
                      ) : (
                        <Space direction="vertical" size={0}>
                          {r.errors.map((e) => (
                            <Typography.Text type="danger" key={e}>
                              <CloseCircleFilled /> {e}
                            </Typography.Text>
                          ))}
                        </Space>
                      ),
                  },
                ]}
              />
            </>
          )}
        </Space>
      )}
    </Modal>
  );
}
