import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { buildOpenApi, configureApp } from './bootstrap';

async function main() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  const config = app.get(ConfigService);
  const docs = config.get('API_DOCS') !== 'off';
  if (docs) SwaggerModule.setup('api/docs', app, buildOpenApi(app));

  const port = Number(config.get('API_PORT') ?? 3000);
  await app.listen(port, '0.0.0.0');
  Logger.log(
    `后端已启动：http://localhost:${port}/api${docs ? ' ，接口文档：/api/docs' : '（接口文档已关闭）'}`,
    'Bootstrap',
  );
}

void main();
