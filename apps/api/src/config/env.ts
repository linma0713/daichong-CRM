import { plainToInstance, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

/** 启动时校验环境变量，配错了直接报中文错误，避免带病运行 */
export class EnvVars {
  @IsString()
  DATABASE_URL: string;

  @IsString()
  @MinLength(32, { message: 'JWT_ACCESS_SECRET 至少 32 位' })
  JWT_ACCESS_SECRET: string;

  @IsOptional()
  @IsString()
  JWT_ACCESS_TTL: string = '2h';

  /** 加密 Claude 账号密码等敏感信息的密钥：64 位十六进制（openssl rand -hex 32） */
  @Matches(/^[0-9a-fA-F]{64}$/, {
    message: 'ACCOUNT_SECRET_KEY 必须是 64 位十六进制字符（可用 openssl rand -hex 32 生成）',
  })
  ACCOUNT_SECRET_KEY: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  JWT_REFRESH_TTL_DAYS: number = 7;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  API_PORT: number = 3000;

  /** 后台的访问地址（例如 https://crm.example.com），群消息里的「在后台打开」链接用它拼 */
  @IsOptional()
  @Matches(/^https?:\/\/[^\s]+$/, { message: 'APP_PUBLIC_URL 要以 http:// 或 https:// 开头' })
  APP_PUBLIC_URL?: string;

  /** 附件（截图、凭证）存放目录；Docker 里是挂了卷的 /app/uploads，备份时要一起备份 */
  @IsOptional()
  @IsString()
  UPLOAD_DIR?: string;

  /** 只在本地联调时使用：把企业微信接口指向模拟服务 */
  @IsOptional()
  @IsString()
  WECOM_API_BASE?: string;
}

export function validateEnv(config: Record<string, unknown>): EnvVars {
  const env = plainToInstance(EnvVars, config, { enableImplicitConversion: true });
  const errors = validateSync(env);
  if (errors.length > 0) {
    const lines = errors.map(
      (e) => `- ${e.property}: ${Object.values(e.constraints ?? {}).join('；')}`,
    );
    throw new Error(`环境变量配置有误，请检查 .env：\n${lines.join('\n')}`);
  }
  return env;
}
