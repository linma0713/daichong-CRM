import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './config/env';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './audit/audit.module';
import { AuditInterceptor } from './audit/audit.interceptor';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard, PermissionsGuard } from './auth/guards';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { TeamsModule } from './teams/teams';
import { HealthModule } from './health/health';
import { SecretBoxModule } from './common/secret-box';
import { SettingsModule } from './settings/settings';
import { CatalogModule } from './catalog/catalog';
import { CustomersModule } from './customers/customers';
import { OrdersModule } from './orders/orders';
import { TasksModule } from './tasks/tasks';
import { SubscriptionsModule } from './subscriptions/subscriptions';
import { SchedulerModule } from './scheduler/sweep';
import { DashboardModule } from './dashboard/dashboard';
import { InventoryModule } from './inventory/inventory';
import { AftersalesModule } from './aftersales/aftersales';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // 在 apps/api 目录下运行：优先读仓库根目录的 .env，其次 apps/api/.env；系统环境变量优先级最高
      envFilePath: ['../../.env', '.env'],
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    ScheduleModule.forRoot(),
    PrismaModule,
    SecretBoxModule,
    AuditModule,
    AuthModule,
    UsersModule,
    RolesModule,
    TeamsModule,
    HealthModule,
    SettingsModule,
    CatalogModule,
    CustomersModule,
    OrdersModule,
    TasksModule,
    SubscriptionsModule,
    SchedulerModule,
    DashboardModule,
    InventoryModule,
    AftersalesModule,
  ],
  providers: [
    // 顺序就是执行顺序：限流 → 登录 → 权限
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
