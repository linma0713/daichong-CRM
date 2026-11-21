import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings';
import { CommissionEngine } from '../commissions/engine';
import { FulfillmentService } from './fulfillment.service';

@Module({
  imports: [SettingsModule],
  providers: [FulfillmentService, CommissionEngine],
  exports: [FulfillmentService, CommissionEngine],
})
export class FulfillmentModule {}
