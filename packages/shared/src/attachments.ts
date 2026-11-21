/** 附件：收款截图、售后截图、打款凭证等 */

export type AttachmentOwnerType = 'order' | 'ticket' | 'refund' | 'customer' | 'statement';
export const ATTACHMENT_OWNER_TYPES: AttachmentOwnerType[] = [
  'order',
  'ticket',
  'refund',
  'customer',
  'statement',
];
export const ATTACHMENT_OWNER_LABELS: Record<AttachmentOwnerType, string> = {
  order: '订单',
  ticket: '售后工单',
  refund: '退款',
  customer: '客户',
  statement: '佣金对账单',
};

/** 单个文件最大 10 MB（和前端 nginx 的 client_max_body_size 一致） */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** 每条业务最多挂多少个附件 */
export const ATTACHMENT_MAX_PER_OWNER = 30;
/** 只收图片和 PDF；类型按文件内容识别，不信扩展名 */
export const ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
] as const;
export type AttachmentMimeType = (typeof ATTACHMENT_MIME_TYPES)[number];

/** 按文件开头的字节识别类型，认不出返回 null（例如 SVG、可执行文件、改了扩展名的文件） */
export function sniffMimeType(head: Uint8Array): AttachmentMimeType | null {
  const at = (i: number, bytes: number[]) => bytes.every((b, k) => head[i + k] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  if (at(0, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  return null;
}

export const ATTACHMENT_EXTENSIONS: Record<AttachmentMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/** 文件大小：1.2 MB / 340 KB */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
