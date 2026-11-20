import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { ContextService } from '../../context/context.service';
import { ConfigSnapshotUtil } from '../../config-center/config-snapshot.util';
import { CommonConfig } from '../../config/common.config';

const traceId = 'baecec72b6ee4035a744eebe1030b87a';
const parentId = 'a49859ec623b429d';
const traceparent = `00-${traceId}-${parentId}-01`;

function inWorker<T>(headers: Request['headers'], callback: () => T): T {
  return ContextService.setStore({ req: { headers } as Request, res: {} as Response }, callback);
}

describe('服务间请求上下文', () => {
  it('接续 W3C 父上下文，worker 和各次出站请求分别使用独立的 span', async () => {
    const result = await inWorker({ traceparent, tracestate: 'vendor=sample' }, async () => {
      const worker = ContextService.getTrace()!;
      expect(worker.traceId).toBe(traceId);
      expect(worker.spanId).not.toBe(parentId);
      expect(ContextService.getTraceHeaders().tracestate).toBe('vendor=sample');
      const first = ContextService.createOutboundTrace();
      const second = ContextService.createOutboundTrace();
      expect(first.headers.traceparent).toBe(`00-${traceId}-${first.spanId}-01`);
      expect(new Set([parentId, worker.spanId, first.spanId, second.spanId]).size).toBe(4);
      first.end();
      second.end();
      return await Promise.resolve('完成');
    });
    expect(result).toBe('完成');
    expect(ContextService.getTrace()).toBeUndefined();
  });

  it('无效父头新建链路，后台处理异常回传到 BullMQ', async () => {
    await expect(
      inWorker({ traceparent: 'invalid', tracestate: 'vendor=old' }, async () => {
        const headers = ContextService.getTraceHeaders();
        expect(headers.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
        expect(headers.tracestate).toBeUndefined();
        throw new Error('后台处理失败');
      }),
    ).rejects.toThrow('后台处理失败');
  });

  it('任务重投可重建相同的业务步骤键，一次领取与其他调用隔离', () => {
    const parent = randomUUID();
    const key = () =>
      inWorker({ 'x-operation-id': parent }, () => ContextService.deriveOperationKey('file-7'));
    expect(key()).toEqual(key());
    expect(key()).not.toEqual(
      inWorker({ 'x-operation-id': parent }, () => ContextService.deriveOperationKey('file-8')),
    );
    expect(
      inWorker({ traceparent }, () => ContextService.deriveOperationKey('file-7')),
    ).toBeUndefined();
    ContextService.withOperationKey(key()!, () => {
      expect(ContextService.takeOperationKey()).toBe(key());
      expect(() => ContextService.takeOperationKey()).toThrow('一个操作键只可绑定一次出站调用');
    });
    expect(ContextService.takeOperationKey()).toBeUndefined();
  });

  it('写重试配置默认关闭，配置中心字符串 false 不会意外开启', () => {
    const base = { ServiceName: 'rag', Port: 3301 };
    for (const [configured, expected] of [
      [undefined, false],
      ['false', false],
      ['true', true],
    ] as const) {
      const config =
        configured === undefined ? base : { ...base, RemoteWriteRetryEnabled: configured };
      expect(ConfigSnapshotUtil.validate(CommonConfig, config).RemoteWriteRetryEnabled).toBe(
        expected,
      );
    }
    expect(() =>
      ConfigSnapshotUtil.validate(CommonConfig, { ...base, RemoteWriteRetryEnabled: 'enabled' }),
    ).toThrow('RemoteWriteRetryEnabled must be a boolean');
  });
});
