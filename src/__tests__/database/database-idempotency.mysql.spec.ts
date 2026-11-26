import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Column, DataSource, Entity } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BaseEntity } from '../../base/base.entity';
import { BaseService } from '../../base/base.service';
import { DatabaseIdempotencyService } from '../../database/database-idempotency.service';

@Entity('business_event')
class BusinessEvent extends BaseEntity {
  @Column({ type: 'text' })
  value!: string;
}

class BusinessEventService extends BaseService<BusinessEvent> {}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const url = process.env.NEST_CLOUD_TEST_MYSQL_URL;
describe.skipIf(!url)('MySQL 跨实例幂等事务', () => {
  const database = 'rpc_test_' + randomUUID().replaceAll('-', '');
  const pools: DataSource[] = [];
  const clients: DatabaseIdempotencyService[] = [];
  const events: BusinessEventService[] = [];
  let control: DataSource;
  let created = false;
  const operation = {
    operation: 'test.write',
    payload: { id: 3, change: 'value' },
    principal: 'test',
  };

  beforeAll(async () => {
    const migration = await readFile(
      process.env.NEST_CLOUD_TEST_MYSQL_RPC_SCHEMA_FILE ||
        path.resolve(
          __dirname,
          '../../../../NestCloud/sql/sdk/add-rpc-idempotency-record.mysql.sql',
        ),
      'utf8',
    );
    control = await new DataSource({ type: 'mysql', url }).initialize();
    await control.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    created = true;
    for (let i = 0; i < 2; ++i) {
      const pool = new DataSource({
        type: 'mysql',
        url,
        database,
        poolSize: 1,
        entities: [BusinessEvent],
      });
      pools.push(pool);
      await pool.initialize();
      clients.push(new DatabaseIdempotencyService(pool));
      events.push(new BusinessEventService(pool.getRepository(BusinessEvent)));
    }
    await pools[0].query(migration);
    await pools[0].query(migration);
    await pools[0].query(`CREATE TABLE business_event (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY, value text NOT NULL, create_user int, update_user int,
      created_at timestamp DEFAULT CURRENT_TIMESTAMP, updated_at timestamp DEFAULT CURRENT_TIMESTAMP,
      deleted_at timestamp NULL
    ) ENGINE=InnoDB`);
  });

  afterAll(async () => {
    await Promise.all(pools.filter((pool) => pool.isInitialized).map((pool) => pool.destroy()));
    if (!control?.isInitialized) return;
    try {
      if (created) await control.query(`DROP DATABASE \`${database}\``);
    } finally {
      await control.destroy();
    }
  });

  it('两个连接池等待同一主键，成功后回放 JSON 并拒绝同键异参', async () => {
    const input = { ...operation, key: randomUUID() };
    const [entered, released] = [deferred(), deferred()];
    const responseText = '文本🐬'.repeat(12_000);
    const first = clients[0].execute(input, async () => {
      const row = await events[0].create({ value: input.key });
      entered.resolve();
      await released.promise;
      return { id: row.id, text: responseText };
    });
    await Promise.race([entered.promise, first]);
    const action = vi.fn();
    const duplicate = clients[1].execute({ ...input, payload: { change: 'value', id: 3 } }, action);
    void duplicate.catch(() => {});
    try {
      await expect
        .poll(
          async () => {
            const rows =
              await control.query<Array<{ Info: string | null }>>('SHOW FULL PROCESSLIST');
            return rows.some((row) => row.Info?.startsWith('INSERT INTO rpc_idempotency_record'));
          },
          { interval: 25, timeout: 2000 },
        )
        .toBe(true);
    } finally {
      released.resolve();
      await first;
    }
    await expect(duplicate).resolves.toEqual(await first);
    await expect(
      clients[1].execute({ ...input, payload: { id: 4 } }, action),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(action).not.toHaveBeenCalled();
    expect(await events[1].findAll({ where: { value: input.key } })).toHaveLength(1);
  });

  it('业务抛错时回滚业务数据和主键，另一实例可用同键接管', async () => {
    const input = { ...operation, key: randomUUID() };
    await expect(
      clients[0].execute(input, async () => {
        await events[0].create({ value: input.key });
        throw new Error('模拟业务写入后失败');
      }),
    ).rejects.toThrow('模拟业务写入后失败');
    expect(await events[1].findAll({ where: { value: input.key } })).toHaveLength(0);
    const result = await clients[1].execute(input, () => events[1].create({ value: input.key }));
    expect(result.id).toBeGreaterThan(0);
    expect(await events[0].findAll({ where: { value: input.key } })).toHaveLength(1);
  });

  it('等待占键超时返回可重试状态，之后回放且恢复池连接原设置', async () => {
    await pools[1].query('SET SESSION innodb_lock_wait_timeout = 9');
    const input = { ...operation, key: randomUUID() };
    const [entered, released] = [deferred(), deferred()];
    const first = clients[0].execute(input, async () => {
      entered.resolve();
      await released.promise;
      return null;
    });
    await Promise.race([entered.promise, first]);
    const duplicate = vi.fn();
    try {
      await expect(clients[1].execute(input, duplicate)).rejects.toMatchObject({
        status: 503,
        message: expect.stringContaining('处理中'),
      });
      const [settings] = await pools[1].query(
        'SELECT @@SESSION.innodb_lock_wait_timeout AS wait_timeout',
      );
      expect(Number(settings.wait_timeout)).toBe(9);
    } finally {
      released.resolve();
      await first;
    }
    await expect(clients[1].execute(input, duplicate)).resolves.toBeNull();
    const [settings] = await pools[1].query(
      'SELECT @@SESSION.innodb_lock_wait_timeout AS wait_timeout',
    );
    expect(Number(settings.wait_timeout)).toBe(9);
    expect(duplicate).not.toHaveBeenCalled();
  }, 9000);
});
