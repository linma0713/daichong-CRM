import { ApiProperty } from '@nestjs/swagger';

/** 各模块共用的简要信息 */
export class UserBriefDto {
  @ApiProperty() id: string;
  @ApiProperty() displayName: string;
}

export class CustomerBriefDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'C00012' }) code: string;
  @ApiProperty() name: string;
  @ApiProperty({ type: String, nullable: true }) wechat: string | null;
  @ApiProperty({ type: String, nullable: true }) telegram: string | null;
}

export const customerBriefSelect = {
  id: true,
  no: true,
  name: true,
  wechat: true,
  telegram: true,
} as const;

export const userBriefSelect = { id: true, displayName: true } as const;
