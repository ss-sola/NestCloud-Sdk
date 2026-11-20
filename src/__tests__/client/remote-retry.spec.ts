import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigKeys } from '../../config/keys';
import { ContextService } from '../../context/context.service';
import { RemoteCall } from '../../http/remote-call.decorator';
import { RemoteClientBase } from '../../http/remote-client.base';
import { LB_Type, RemoteService } from '../../http/remote-service.decorator';
import { RemoteRetryPolicy } from '../../http/remote-retry.policy';
import { REMOTE_RETRY_BUDGET_MS } from '../../constants/remote-retry.constants';

const config = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../config-center', () => ({
  getConfig: (key: string, fallback?: unknown) => config.get(key) ?? fallback,
}));

@RemoteService({ name: 'items', lb: LB_Type.ROUND_ROBIN })
class ItemsClient extends RemoteClientBase {
  @RemoteCall('/items', 'POST', { retry: 'idempotent-write' })
  create(input: { name: string }): Promise<unknown> {
    return this.self.create(input);
  }

  @RemoteCall('/items/find', 'POST', { retry: 'read' })
  find(query: { id: number }): Promise<unknown> {
    return this.self.find(query);
  }

  @RemoteCall('/items/send', 'POST')
  send(): Promise<unknown> {
    return this.self.send();
  }

  @RemoteCall('https://example.invalid:8443/foreign', 'POST', { retry: 'idempotent-write' })
  foreign(): Promise<unknown> {
    return this.self.foreign();
  }
}

const unavailable = { isAxiosError: true, response: { status: 503, headers: {} } };
const disconnected = { isAxiosError: true, code: 'ECONNRESET', request: {} };
const success = { data: { ok: true }, status: 200 };

describe('远程调用重试', () => {
  let client: ItemsClient;

  beforeEach(() => {
    config.clear();
    config.set(ConfigKeys.NodeEnv, 'production');
    config.set(ConfigKeys.RemoteWriteRetryEnabled, true);
    client = Object.assign(new ItemsClient(), {
      registryClient: {
        getInstances: () => [
          { id: 'first', host: 'first.internal', port: 3100 },
          { id: 'second', host: 'second.internal', port: 3100 },
        ],
      },
    });
    vi.spyOn(ContextService, 'getOptionalReq').mockReturnValue({
      headers: {
        'idempotency-key': 'parent',
        'x-operation-id': 'parent-step',
        'x-request-id': 'edge-request',
      },
    } as unknown as ReturnType<typeof ContextService.getOptionalReq>);
  });

  afterEach(() => vi.restoreAllMocks());

  it('写请求超时后切换实例，保持子操作键和 traceId，每次使用独立 span', async () => {
    const request = vi
      .spyOn(axios, 'request')
      .mockRejectedValueOnce(disconnected)
      .mockResolvedValue(success);
    expect(await client.create({ name: 'test' })).toEqual(success.data);
    const [first, second] = request.mock.calls.map(([options]) => options);
    expect(first.url).toContain('first.internal');
    expect(second.url).toContain('second.internal');
    expect([first.maxRedirects, second.maxRedirects]).toEqual([0, 0]);
    const key = first.headers!['Idempotency-Key'];
    expect(key).toBeTruthy();
    expect(key).not.toBe('parent');
    expect(second.headers!['Idempotency-Key']).toBe(key);
    expect(second.headers).not.toHaveProperty('x-operation-id');
    expect(second.headers!['x-request-id']).toBe('edge-request');
    const parent = String(first.headers!.traceparent).split('-');
    const child = String(second.headers!.traceparent).split('-');
    expect(child[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(child[1]).toBe(parent[1]);
    expect(child[2]).not.toBe(parent[2]);
    expect(first.data).toEqual(second.data);
    await client.create({ name: 'test' });
    expect(request.mock.calls[2][0].headers!['Idempotency-Key']).not.toBe(key);
  });

  it('关闭写重试时仍向接收端提供幂等键，但只发送一次', async () => {
    config.delete(ConfigKeys.RemoteWriteRetryEnabled);
    const request = vi.spyOn(axios, 'request').mockRejectedValue(unavailable);
    await expect(client.create({ name: 'test' })).rejects.toThrow('状态码: 503');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0].headers!['Idempotency-Key']).toBeTruthy();
  });

  it('显式步骤键用于已保护的写和单次异步 RPC', async () => {
    const request = vi.spyOn(axios, 'request').mockResolvedValue(success);
    await ContextService.withOperationKey('step-key', () => client.create({ name: 'step' }));
    await ContextService.withOperationKey('other-step', () => client.send());
    expect(request.mock.calls[0][0].headers!['Idempotency-Key']).toBe('step-key');
    expect(request.mock.calls[1][0].headers!['x-operation-id']).toBe('other-step');
    expect(request.mock.calls[1][0].headers).not.toHaveProperty('Idempotency-Key');
  });

  it('外站和未声明的写单次发送且不透传父操作键', async () => {
    const request = vi.spyOn(axios, 'request').mockRejectedValue(disconnected);
    await expect(
      ContextService.withOperationKey('local-key', () => client.foreign()),
    ).rejects.toThrow('远程调用无响应');
    await expect(client.send()).rejects.toThrow('远程调用无响应');
    expect(request).toHaveBeenCalledTimes(2);
    for (const [options] of request.mock.calls) {
      const names = Object.keys(options.headers!).map((key) => key.toLowerCase());
      expect(names).not.toContain('idempotency-key');
      expect(names).not.toContain('x-operation-id');
    }
  });

  it.each([400, 401, 409, 422, 429, 500])('状态 %i 不触发普通读重试', async (status) => {
    const request = vi
      .spyOn(axios, 'request')
      .mockRejectedValue({ ...unavailable, response: { status, headers: {} } });
    await expect(client.find({ id: 3 })).rejects.toThrow(`状态码: ${status}`);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('读操作在 503 后重试，总尝试数有上限', async () => {
    const request = vi.spyOn(axios, 'request').mockRejectedValue(unavailable);
    await expect(client.find({ id: 3 })).rejects.toThrow('状态码: 503');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('总预算包含退避与所有尝试，超出服务端 Retry-After 时结束', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const policy = new RemoteRetryPolicy(true);
    clock.mockReturnValue(REMOTE_RETRY_BUDGET_MS - 20);
    expect(policy.requestLimits(1000)?.timeout).toBe(20);
    expect(
      policy.nextDelay(
        { isAxiosError: true, response: { status: 429, headers: { 'retry-after': '10' } } },
        1,
      ),
    ).toBeUndefined();
    clock.mockReturnValue(REMOTE_RETRY_BUDGET_MS);
    expect(policy.requestLimits(1000)).toBeUndefined();
  });
});
