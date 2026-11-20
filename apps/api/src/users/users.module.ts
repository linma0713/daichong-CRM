import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { StaffController } from './staff.controller';

@Module({
  controllers: [UsersController, StaffController],
  providers: [UsersService],
})
export class UsersModule {}
