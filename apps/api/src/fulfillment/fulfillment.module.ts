import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings';
import { FulfillmentService } from './fulfillment.service';

@Module({
  imports: [SettingsModule],
  providers: [FulfillmentService],
  exports: [FulfillmentService],
})
export class FulfillmentModule {}
