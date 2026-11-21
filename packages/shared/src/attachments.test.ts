import { describe, expect, it } from 'vitest';
import { formatBytes, sniffMimeType } from './attachments';

const bytes = (...b: number[]) => Uint8Array.from([...b, ...new Array(16).fill(0)]);

describe('sniffMimeType', () => {
  it('按文件头识别图片和 PDF', () => {
    expect(sniffMimeType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniffMimeType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffMimeType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('image/gif');
    expect(sniffMimeType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe(
      'image/webp',
    );
    expect(sniffMimeType(new TextEncoder().encode('%PDF-1.7\n'))).toBe('application/pdf');
  });

  it('其他内容一律不收（SVG、HTML、空文件、只像一半的 WEBP）', () => {
    expect(
      sniffMimeType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')),
    ).toBeNull();
    expect(sniffMimeType(new TextEncoder().encode('<!doctype html>'))).toBeNull();
    expect(sniffMimeType(new Uint8Array())).toBeNull();
    expect(
      sniffMimeType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x41, 0x56, 0x49, 0x20)),
    ).toBeNull();
  });
});

describe('formatBytes', () => {
  it('换算成 KB / MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(340 * 1024)).toBe('340 KB');
    expect(formatBytes(1.25 * 1024 * 1024)).toBe('1.3 MB');
  });
});
