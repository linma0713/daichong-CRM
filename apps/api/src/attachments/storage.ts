import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/**
 * 附件文件的存放。现在存本地目录（Docker 里是 uploads 卷），以后上云可以换成对象存储，
 * 业务代码只通过这里读写。
 */
@Injectable()
export class FileStorage {
  private readonly logger = new Logger(FileStorage.name);
  readonly root: string;

  constructor(config: ConfigService) {
    this.root = resolve(config.get<string>('UPLOAD_DIR') || 'uploads');
  }

  /** 生成一个新的存储路径：年/月/随机名.扩展名 */
  newKey(ext: string, now = new Date()): string {
    const ym = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    return `${ym}/${randomBytes(16).toString('hex')}.${ext}`;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data, { flag: 'wx' });
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.path(key))).isFile();
    } catch {
      return false;
    }
  }

  read(key: string): ReadStream {
    return createReadStream(this.path(key));
  }

  /** 删除文件；文件已经不在了也不报错（只记日志） */
  async remove(key: string): Promise<void> {
    try {
      await rm(this.path(key), { force: true });
    } catch (err) {
      this.logger.warn(`删除附件文件失败 ${key}：${(err as Error).message}`);
    }
  }

  /** key 只能落在 root 目录里面 */
  private path(key: string): string {
    const file = resolve(this.root, key);
    if (!file.startsWith(this.root + sep)) throw new Error(`非法的存储路径：${key}`);
    return file;
  }
}
