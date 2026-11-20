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
  SwaggerModule.setup('api/docs', app, buildOpenApi(app));

  const port = Number(app.get(ConfigService).get('API_PORT') ?? 3000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`后端已启动：http://localhost:${port}/api ，接口文档：/api/docs`, 'Bootstrap');
}

void main();
