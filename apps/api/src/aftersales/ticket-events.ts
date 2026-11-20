import type { Tx } from '../fulfillment/fulfillment.service';

/** 工单时间线的事件类型 */
export type TicketEventKind =
  | 'created'
  | 'comment'
  | 'status'
  | 'assign'
  | 'fault'
  | 'escalated'
  | 'replace'
  | 'compensate'
  | 'refund'
  | 'resolved'
  | 'closed'
  | 'reopened';

/** 往工单时间线上记一笔（换号任务、退款审批等其他模块也会调用） */
export async function recordTicketEvent(
  tx: Tx,
  data: { ticketId: string; kind: TicketEventKind; content?: string; userId?: string | null },
): Promise<void> {
  await tx.ticketEvent.create({
    data: {
      ticketId: data.ticketId,
      kind: data.kind,
      content: data.content ?? null,
      userId: data.userId ?? null,
    },
  });
}

/** 换号完成、退款出账后，工单还没解决的话自动标记为已解决（之后按设置自动关闭） */
export async function resolveTicketBySystem(
  tx: Tx,
  ticketId: string,
  resolution: string,
  userId: string | null,
  now = new Date(),
): Promise<void> {
  const ticket = await tx.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket || ticket.status === 'RESOLVED' || ticket.status === 'CLOSED') return;
  await tx.ticket.update({
    where: { id: ticketId },
    data: { status: 'RESOLVED', resolution, resolvedAt: now },
  });
  await recordTicketEvent(tx, { ticketId, kind: 'resolved', content: resolution, userId });
}
