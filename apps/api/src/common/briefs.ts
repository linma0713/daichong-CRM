import { ApiProperty } from '@nestjs/swagger';
import { displayNo } from '@crm/shared';

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

export class AccountBriefDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty({
    enum: ['CUSTOMER', 'COMPANY'],
    description: 'CUSTOMER 客户自己的号 / COMPANY 成品号',
  })
  ownership: string;
  @ApiProperty({ description: '是否录入了密码（明文要单独查看）' }) hasPassword: boolean;
  @ApiProperty({ description: '是否录入了其他敏感信息' }) hasSecretNote: boolean;
}

export const accountBriefSelect = {
  id: true,
  email: true,
  ownership: true,
  passwordEnc: true,
  secretNoteEnc: true,
} as const;

export function toAccountBrief(a: {
  id: string;
  email: string;
  ownership: string;
  passwordEnc: string | null;
  secretNoteEnc: string | null;
}): AccountBriefDto {
  return {
    id: a.id,
    email: a.email,
    ownership: a.ownership,
    hasPassword: !!a.passwordEnc,
    hasSecretNote: !!a.secretNoteEnc,
  };
}

export class AgentBriefDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'A00003' }) code: string;
  @ApiProperty() name: string;
}

export const agentBriefSelect = { id: true, no: true, name: true } as const;

export function toAgentBrief(a: { id: string; no: number; name: string }): AgentBriefDto {
  return { id: a.id, code: displayNo('A', a.no), name: a.name };
}
