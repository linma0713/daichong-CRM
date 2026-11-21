import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/** 应用级配置，正式启动和测试共用，保证两边行为一致 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
  // 前面有几层反向代理就信任几层 X-Forwarded-For，取到真实的客户端 IP
  (app as NestExpressApplication).set(
    'trust proxy',
    Number(app.get(ConfigService).get('TRUST_PROXY') ?? 1),
  );
  // 默认 100kb 不够批量导入 500 行客户用
  (app as NestExpressApplication).useBodyParser('json', { limit: '2mb' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();
}

/** 生成 OpenAPI 文档：管理后台、以后的小程序和 App 都用它生成接口代码 */
export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('代充 CRM 接口')
    .setDescription(
      '内部管理后台接口。除登录外都需要在请求头带 Authorization: Bearer <accessToken>。',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, config, {
    operationIdFactory: (controllerKey, methodKey) =>
      `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
  });
}
