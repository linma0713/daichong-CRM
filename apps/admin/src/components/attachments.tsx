import { useEffect, useRef, useState, type DragEvent } from 'react';
import { App, Button, Image, Modal, Popconfirm, Space, Spin, Tooltip, Typography } from 'antd';
import {
  DeleteOutlined,
  FilePdfOutlined,
  LoadingOutlined,
  PaperClipOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_OWNER,
  formatBytes,
  type AttachmentOwnerType,
} from '@crm/shared';
import { api, apiFetch, unwrap, type Schemas } from '../api/client';
import { toApiError } from '../api/errors';
import { formatTime } from './format';

type Attachment = Schemas['AttachmentDto'];

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf';
const THUMB = 88;

/** 截图粘贴进来浏览器统一叫 image.png，换成带时间的名字，列表里好区分 */
function namePasted(f: File, i: number): File {
  if (f.name && !/^image\.\w+$/i.test(f.name)) return f;
  const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
  const suffix = i > 0 ? `_${i + 1}` : '';
  return new File([f], `截图_${dayjs().format('YYYYMMDD_HHmmss')}${suffix}.${ext}`, {
    type: f.type,
  });
}

/** 带令牌取附件文件，转成本页面能用的 blob 地址；离开页面时释放 */
function useFileUrl(id: string) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    apiFetch(`/api/attachments/${id}/file`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        objectUrl = URL.createObjectURL(await res.blob());
        if (revoked) URL.revokeObjectURL(objectUrl);
        else setUrl(objectUrl);
      })
      .catch(() => !revoked && setFailed(true));
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);
  return { url, failed };
}

function Thumb({ a, onDelete }: { a: Attachment; onDelete?: () => void }) {
  const { url, failed } = useFileUrl(a.id);
  const isImage = a.mimeType.startsWith('image/');
  const box = {
    width: THUMB,
    height: THUMB,
    borderRadius: 6,
    border: '1px solid #f0f0f0',
    background: '#fafafa',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  } as const;
  return (
    <div style={{ width: THUMB, position: 'relative' }}>
      <Tooltip
        title={
          <span>
            {a.fileName}
            <br />
            {formatBytes(a.size)} · {a.uploadedBy.displayName} · {formatTime(a.createdAt)}
          </span>
        }
      >
        <div style={box}>
          {failed ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              文件丢失
            </Typography.Text>
          ) : !url ? (
            <Spin indicator={<LoadingOutlined />} size="small" />
          ) : isImage ? (
            <Image
              src={url}
              alt={a.fileName}
              width={THUMB}
              height={THUMB}
              style={{ objectFit: 'cover' }}
              preview={{ mask: '查看' }}
            />
          ) : (
            <a
              href={url}
              download={a.fileName}
              style={{ textAlign: 'center', fontSize: 12, padding: 4 }}
            >
              <FilePdfOutlined style={{ fontSize: 28, color: '#cf1322' }} />
              <div style={{ wordBreak: 'break-all', lineHeight: 1.3, marginTop: 4 }}>
                {a.fileName.length > 16 ? `${a.fileName.slice(0, 14)}…` : a.fileName}
              </div>
            </a>
          )}
        </div>
      </Tooltip>
      {onDelete && (
        <Popconfirm
          title="删除这个附件？"
          okText="删除"
          okButtonProps={{ danger: true }}
          onConfirm={onDelete}
        >
          <Button
            size="small"
            shape="circle"
            danger
            icon={<DeleteOutlined />}
            aria-label={`删除 ${a.fileName}`}
            style={{
              position: 'absolute',
              top: -8,
              right: -8,
              width: 22,
              minWidth: 22,
              height: 22,
            }}
          />
        </Popconfirm>
      )}
    </div>
  );
}

/**
 * 附件区：缩略图 + 上传。可以点按钮选文件、把文件拖进来，或者点一下这块区域再按 Ctrl+V 粘贴截图。
 */
export function Attachments({
  ownerType,
  ownerId,
  canUpload,
  hint = '收款截图、聊天记录、转账凭证等',
}: {
  ownerType: AttachmentOwnerType;
  ownerId: string;
  canUpload: boolean;
  hint?: string;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const key = ['attachments', ownerType, ownerId];
  const list = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(api.GET('/api/attachments', { params: { query: { ownerType, ownerId } } })),
  });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('ownerType', ownerType);
      form.append('ownerId', ownerId);
      form.append('file', file, file.name || 'paste.png');
      const res = await apiFetch('/api/attachments', { method: 'POST', body: form });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(body, res.status);
      return body as Attachment;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/api/attachments/{id}', { params: { path: { id } } })),
    onSuccess: () => {
      message.success('已删除');
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const items = list.data ?? [];
  const send = async (files: File[]) => {
    const room = ATTACHMENT_MAX_PER_OWNER - items.length;
    if (room <= 0) {
      message.warning(`最多 ${ATTACHMENT_MAX_PER_OWNER} 个附件`);
      return;
    }
    let ok = 0;
    for (const f of files.slice(0, room)) {
      if (f.size > ATTACHMENT_MAX_BYTES) {
        message.error(`「${f.name}」超过 10 MB`);
        continue;
      }
      if (f.type && !ACCEPT.split(',').includes(f.type)) {
        message.error(`「${f.name}」不是图片或 PDF`);
        continue;
      }
      try {
        await upload.mutateAsync(f);
        ok++;
      } catch {
        // 错误提示由全局统一弹出
      }
    }
    if (ok) message.success(ok > 1 ? `已上传 ${ok} 个附件` : '已上传');
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (canUpload) void send([...e.dataTransfer.files]);
  };

  return (
    <div
      tabIndex={canUpload ? 0 : undefined}
      onPaste={(e) => {
        if (!canUpload) return;
        const files = [...e.clipboardData.files].map(namePasted);
        if (files.length) {
          e.preventDefault();
          void send(files);
        }
      }}
      onDragOver={(e) => {
        if (!canUpload) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className="attachments-zone"
      style={{
        outline: dragging ? '2px dashed #1677ff' : undefined,
        borderRadius: 8,
      }}
      aria-label="附件"
    >
      <Space size={[12, 12]} wrap align="start">
        {items.map((a) => (
          <Thumb key={a.id} a={a} onDelete={a.canDelete ? () => remove.mutate(a.id) : undefined} />
        ))}
        {canUpload && (
          <button
            type="button"
            className="attachments-add"
            onClick={() => inputRef.current?.click()}
            disabled={upload.isPending}
            style={{ width: THUMB, height: THUMB }}
          >
            {upload.isPending ? <LoadingOutlined /> : <UploadOutlined />}
            <span>{upload.isPending ? '上传中' : '上传'}</span>
          </button>
        )}
      </Space>
      {!list.isLoading && items.length === 0 && !canUpload && (
        <Typography.Text type="secondary">
          <PaperClipOutlined /> 没有附件
        </Typography.Text>
      )}
      {canUpload && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '8px 0 0' }}>
          {hint}。点「上传」选文件、把文件拖到这里，或者点一下这块区域再按 Ctrl+V 粘贴截图（图片或
          PDF，单个 10 MB 以内）
        </Typography.Paragraph>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          void send(files);
        }}
      />
    </div>
  );
}

/** 表格里的「凭证」入口：点开弹窗看 / 传附件 */
export function AttachmentsButton({
  ownerType,
  ownerId,
  title,
  canUpload,
  hint,
}: {
  ownerType: AttachmentOwnerType;
  ownerId: string;
  title: string;
  canUpload: boolean;
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="link" size="small" icon={<PaperClipOutlined />} onClick={() => setOpen(true)}>
        凭证
      </Button>
      {open && (
        <Modal open title={title} footer={null} onCancel={() => setOpen(false)} width={560}>
          <Attachments ownerType={ownerType} ownerId={ownerId} canUpload={canUpload} hint={hint} />
        </Modal>
      )}
    </>
  );
}
