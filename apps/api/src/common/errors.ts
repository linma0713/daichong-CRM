import { BadRequestException, NotFoundException } from '@nestjs/common';

/** 业务校验失败，返回 { code, message } */
export function badRequest(message: string, code = 'BAD_REQUEST'): BadRequestException {
  return new BadRequestException({ code, message });
}

/** 数据不存在，或不在当前员工的数据范围内 */
export function notFound(what: string): NotFoundException {
  return new NotFoundException({ code: 'NOT_FOUND', message: `${what}不存在或你没有权限查看` });
}
