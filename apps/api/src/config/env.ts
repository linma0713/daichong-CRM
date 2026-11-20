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
