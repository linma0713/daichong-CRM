import { BadRequestException } from '@nestjs/common';

/** 业务校验失败，返回 { code, message } */
export function badRequest(message: string, code = 'BAD_REQUEST'): BadRequestException {
  return new BadRequestException({ code, message });
}
