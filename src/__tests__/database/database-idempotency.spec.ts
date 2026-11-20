import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { ContextService } from '../../context/context.service';
import { DatabaseIdempotencyService } from '../../database/database-idempotency.service';
import { AccountSessionRequest } from '../../system-auth/system-auth.types';

const operation = { operation: 'test.update', payload: { id: 7 } };

describe('DatabaseIdempotencyService HTTP 接入', () => {
  const unavailable = { options: { type: 'postgres' }, transaction: vi.fn() };
  const service = new DatabaseIdempotencyService(unavailable as unknown as DataSource);

  afterEach(() => {
    vi.restoreAllMocks();
    unavailable.transaction.mockReset();
  });

  function request(key?: string, accountId?: number) {
    vi.spyOn(ContextService, 'getReq').mockReturnValue({
      headers: key === undefined ? {} : { 'idempotency-key': key },
      session: accountId === undefined ? {} : { account: { accountId } },
    } as AccountSessionRequest);
  }

  it('兼容无键旧调用，每次只调用一次业务', async () => {
    request();
    const action = vi.fn().mockResolvedValue(true);
    expect(await service.executeHttp(operation, action)).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    expect(unavailable.transaction).not.toHaveBeenCalled();
  });

  it('拒绝有键但未经认证的私有写调用', async () => {
    request('operation-1');
    const action = vi.fn();
    await expect(async () => service.executeHttp(operation, action)).rejects.toMatchObject({
      status: 401,
    });
    expect(action).not.toHaveBeenCalled();
  });

  it.each(['', 'two, keys', 'x'.repeat(129)])('拒绝不合法的键 %j', async (key) => {
    request(key, 12);
    const action = vi.fn();
    await expect(async () => service.executeHttp(operation, action)).rejects.toMatchObject({
      status: 400,
    });
    expect(action).not.toHaveBeenCalled();
  });

  it('事务存储不可用时不会放行写入', async () => {
    request('operation-1', 12);
    unavailable.transaction.mockRejectedValue(new Error('offline'));
    const action = vi.fn();
    await expect(service.executeHttp(operation, action)).rejects.toMatchObject({ status: 503 });
    expect(action).not.toHaveBeenCalled();
  });
});
