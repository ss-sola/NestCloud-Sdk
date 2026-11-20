import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Column, DataSource, Entity } from 'typeorm';
import { BaseEntity } from '../../base/base.entity';
import { BaseService } from '../../base/base.service';
import { DatabaseIdempotencyService } from '../../database/database-idempotency.service';
import { ContextService } from '../../context/context.service';
import { AccountSessionRequest } from '../../system-auth/system-auth.types';

@Entity('business_event')
class BusinessEvent extends BaseEntity {
  @Column({ type: 'text' })
  value!: string;
}

class BusinessEventService extends BaseService<BusinessEvent> {}

// 仅在显式提供临时数据库时运行。每次在随机独立 schema 内测试两个真实连接池。
const url = process.env.NEST_CLOUD_TEST_POSTGRES_URL;
describe.skipIf(!url)('PostgreSQL 跨实例幂等事务', () => {
  const schema = 'rpc_test_' + randomUUID().replaceAll('-', '');
  const control = new DataSource({ type: 'postgres', url });
  const pools = ['first', 'second'].map(
    (name) =>
      new DataSource({
        type: 'postgres',
        url,
        schema,
        entities: [BusinessEvent],
        extra: { options: `-c search_path=${schema}`, application_name: `${schema}_${name}` },
      }),
  );
  const clients = pools.map((db) => new DatabaseIdempotencyService(db));
  const events = pools.map((db) => new BusinessEventService(db.getRepository(BusinessEvent)));
  const operation = {
    operation: 'test.write',
    payload: { id: 3, change: 'value' },
    principal: 'test',
  };

  beforeAll(async () => {
    const migration = await readFile(
      process.env.NEST_CLOUD_TEST_RPC_SCHEMA_FILE ||
        path.resolve(__dirname, '../../../../NestCloud/sql/sdk/add-rpc-idempotency-record.sql'),
      'utf8',
    );
    await control.initialize();
    await control.query(`CREATE SCHEMA ${schema}`);
    await Promise.all(pools.map((pool) => pool.initialize()));
    await pools[0].query(migration);
    await pools[0].query(`CREATE TABLE business_event (
      id serial PRIMARY KEY, value text NOT NULL, create_user int, update_user int,
      created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now(), deleted_at timestamp
    )`);
  });

  afterAll(async () => {
    await Promise.all(pools.filter((pool) => pool.isInitialized).map((pool) => pool.destroy()));
    if (control.isInitialized) {
      await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await control.destroy();
    }
  });

  it('并发重复写等待同一事务；提交后丢失响应也只回放首次业务结果', async () => {
    const input = { ...operation, key: randomUUID() };
    let notifyEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let invocations = 0;
    const first = clients[0].execute(input, async () => {
      invocations++;
      const row = await events[0].create({ value: input.key });
      notifyEntered();
      await released;
      return { id: row.id };
    });
    await Promise.race([entered, first]);
    const retry = () =>
      clients[1].execute({ ...input, payload: { change: 'value', id: 3 } }, async () => {
        invocations++;
        const row = await events[1].create({ value: input.key });
        return { id: row.id };
      });
    const concurrent = retry();
    try {
      await expect
        .poll(
          async () => {
            const rows = await control.query(
              "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
              [`${schema}_second`],
            );
            return rows.length;
          },
          { interval: 15, timeout: 2000 },
        )
        .toBe(1);
    } finally {
      release();
    }
    const [original, replay] = await Promise.all([first, concurrent]);
    expect(replay).toEqual(original);
    await expect(retry()).resolves.toEqual(original);
    expect(invocations).toBe(1);
    expect(await events[0].findAll({ where: { value: input.key } })).toHaveLength(1);

    await expect(
      clients[1].execute({ ...input, payload: { id: 4 } }, async () => {
        throw new Error('不应执行业务');
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('业务抛错时业务行和幂等记录一起回滚，同键可在另一实例接管', async () => {
    const input = { ...operation, key: randomUUID() };
    await expect(
      clients[0].execute(input, async () => {
        await events[0].create({ value: input.key });
        throw new Error('模拟业务写入后失败');
      }),
    ).rejects.toThrow('模拟业务写入后失败');
    expect(await events[1].findAll({ where: { value: input.key } })).toHaveLength(0);
    const result = await clients[1].execute(input, async () => {
      const row = await events[1].create({ value: input.key });
      return { id: row.id };
    });
    expect(result.id).toBeGreaterThan(0);
    expect(await events[0].findAll({ where: { value: input.key } })).toHaveLength(1);
  });

  it('已登录的公开请求遇到会话过期，拒绝跨身份回放或再次写入', async () => {
    const key = randomUUID();
    const input = { operation: 'test.public.write', payload: { id: 5 }, allowPublic: true };
    const headers = { 'idempotency-key': key };
    const request = vi.spyOn(ContextService, 'getReq');
    const action = vi.fn(async () => {
      await events[0].create({ value: key });
      return true;
    });
    try {
      request.mockReturnValue({
        headers,
        session: { account: { accountId: 4 } },
      } as unknown as AccountSessionRequest);
      await expect(clients[0].executeHttp(input, action)).resolves.toBe(true);
      request.mockReturnValue({ headers } as unknown as AccountSessionRequest);
      await expect(clients[1].executeHttp(input, action)).rejects.toMatchObject({ status: 409 });
      expect(action).toHaveBeenCalledTimes(1);
    } finally {
      request.mockRestore();
    }
  });

  it('唯一键等待超限返回可重试的处理中状态，首次请求仍然可以提交', async () => {
    const input = { ...operation, key: randomUUID() };
    let notifyEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = clients[0].execute(input, async () => {
      notifyEntered();
      await released;
      return true;
    });
    const duplicate = vi.fn();
    await Promise.race([entered, first]);
    try {
      await expect(clients[1].execute(input, duplicate)).rejects.toMatchObject({
        status: 503,
        message: expect.stringContaining('处理中'),
      });
    } finally {
      release();
      await first;
    }
    await expect(clients[1].execute(input, duplicate)).resolves.toBe(true);
    expect(duplicate).not.toHaveBeenCalled();
  }, 10000);
});
