import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/**
 * 敏感信息加密（AES-256-GCM）。Claude 账号密码等只以密文入库，
 * 查看明文必须走单独的接口并记操作日志。
 */
@Injectable()
export class SecretBox {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const hex = config.getOrThrow<string>('ACCOUNT_SECRET_KEY');
    this.key = Buffer.from(hex, 'hex');
    if (/^0+$/.test(hex)) {
      new Logger(SecretBox.name).warn(
        '正在使用示例密钥 ACCOUNT_SECRET_KEY，上云前请用 openssl rand -hex 32 重新生成',
      );
    }
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION}:${Buffer.concat([iv, tag, data]).toString('base64')}`;
  }

  decrypt(payload: string): string {
    const [version, body] = payload.split(':');
    if (version !== VERSION || !body) throw new Error('无法识别的密文格式');
    const raw = Buffer.from(body, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }

  /** 空值不加密，直接存 null */
  encryptOptional(plain: string | null | undefined): string | null {
    return plain ? this.encrypt(plain) : null;
  }
}

@Global()
@Module({ providers: [SecretBox], exports: [SecretBox] })
export class SecretBoxModule {}
