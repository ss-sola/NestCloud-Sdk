import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { ContextService } from '@/context/context.service';
import {
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_LOCK_TIMEOUT_MS,
  MYSQL_DUPLICATE_ENTRY,
  MYSQL_RETRYABLE_LOCK_ERRORS,
  POSTGRES_LOCK_NOT_AVAILABLE,
} from '@/constants/idempotency.constants';
import { ProjectException } from '@/exception/global.exception';
import { IdempotencyUtil } from '@/util/idempotency.util';
import { TransactionContextService } from './transaction-context.service';

interface ProtectedOperation {
  /** 稳定、包含服务名称的业务操作标识。 */
  operation: string;
  /** 只包含会影响本次写入的、经过校验的 JSON 字段。 */
  payload: unknown;
}

export interface IdempotentHttpOperation extends ProtectedOperation {
  /** 仅允许原本公开且响应可跨匿名调用方回放的操作启用。 */
  allowPublic?: boolean;
}

export interface IdempotentOperation extends ProtectedOperation {
  principal: string;
  key: string;
}

const idempotencySql = {
  postgres: {
    claim:
      'INSERT INTO rpc_idempotency_record (operation_key, request_hash) VALUES ($1, $2) ' +
      'ON CONFLICT (operation_key) DO NOTHING RETURNING operation_key',
    save: 'UPDATE rpc_idempotency_record SET response_body = $1 WHERE operation_key = $2',
    replay:
      'SELECT request_hash, response_body FROM rpc_idempotency_record WHERE operation_key = $1',
  },
  mysql: {
    claim: 'INSERT INTO rpc_idempotency_record (operation_key, request_hash) VALUES (?, ?)',
    save: 'UPDATE rpc_idempotency_record SET response_body = ? WHERE operation_key = ?',
    replay:
      'SELECT request_hash, response_body FROM rpc_idempotency_record WHERE operation_key = ?',
  },
};

type DatabaseType = keyof typeof idempotencySql;

@Injectable()
export class DatabaseIdempotencyService {
  private readonly logger = new Logger(DatabaseIdempotencyService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** 原接口继续接受无键请求。有键请求的作用域只认服务端已验证的身份。 */
  executeHttp<T>(input: IdempotentHttpOperation, action: () => Promise<T>): Promise<T> {
    const request = ContextService.getReq();
    const key = request.headers['idempotency-key'];
    if (key === undefined) return action();
    if (typeof key !== 'string') throw new ProjectException('幂等键格式错误', 400);
    const accountId = request.session?.account?.accountId;
    if (accountId == null && !input.allowPublic) {
      throw new ProjectException('此幂等操作需要已验证的调用身份', 401);
    }
    if (input.allowPublic) {
      // 会话在两次尝试之间失效时仍命中同一条记录；身份变化与参数变化都返回冲突。
      return this.execute(
        { ...input, principal: 'public', payload: [accountId ?? null, input.payload], key },
        action,
      );
    }
    return this.execute({ ...input, principal: `account:${accountId}`, key }, action);
  }

  /** 仅支持同库事务内的写入和可序列化的 JSON 返回值。 */
  async execute<T>(input: IdempotentOperation, action: () => Promise<T>): Promise<T> {
    if (typeof input.key !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(input.key)) {
      throw new ProjectException('幂等键格式错误', 400);
    }
    if (!input.principal || !input.operation) throw new ProjectException('幂等操作缺少作用域');
    const type = this.dataSource.options.type;
    if (type !== 'postgres' && type !== 'mysql')
      throw new ProjectException('幂等写入需要 PostgreSQL 或 MySQL', 503);
    if (TransactionContextService.isActive()) throw new ProjectException('不可嵌套开启幂等事务');

    const key = IdempotencyUtil.digest(
      JSON.stringify([input.operation, input.principal, input.key]),
    );
    const fingerprint = IdempotencyUtil.fingerprint(input.payload);
    let businessFailure: { error: unknown } | undefined;
    const run = async (manager: EntityManager): Promise<T> => {
      if (type === 'postgres') {
        await manager.query("SELECT set_config('lock_timeout', $1, true)", [
          `${IDEMPOTENCY_LOCK_TIMEOUT_MS}ms`,
        ]);
      }
      // 并发 INSERT 会等待同一唯一键的持有事务提交或回滚。下一条语句看到新的已提交快照。
      if (!(await this.claim(manager, type, key, fingerprint))) {
        return this.replay<T>(manager, type, key, fingerprint);
      }

      let result: T;
      try {
        result = await TransactionContextService.run(manager, action);
      } catch (error) {
        businessFailure = { error };
        throw error;
      }
      const body = JSON.stringify(result);
      if (body === undefined) throw new ProjectException('幂等写入须返回 JSON 响应');
      await manager.query(idempotencySql[type].save, [body, key]);
      return result;
    };
    try {
      return await (type === 'mysql'
        ? this.mysqlTransaction(run)
        : this.dataSource.transaction('READ COMMITTED', run));
    } catch (error) {
      if (businessFailure?.error === error || error instanceof ProjectException) throw error;
      const code = this.errorCode(error);
      this.logger.error(`幂等事务失败，操作=${input.operation}，代码=${code}`);
      throw new ProjectException('幂等存储暂不可用，请使用原幂等键重试', 503);
    }
  }

  private async mysqlTransaction<T>(run: (manager: EntityManager) => Promise<T>): Promise<T> {
    const runner = this.dataSource.createQueryRunner();
    const setTimeoutSql = 'SET SESSION innodb_lock_wait_timeout = ?';
    try {
      const connection = (await runner.connect()) as { destroy(): void };
      const [settings] = await runner.manager.query<[{ lockTimeout: number | string }]>(
        'SELECT @@SESSION.innodb_lock_wait_timeout AS lockTimeout',
      );
      const lockTimeout = Number(settings.lockTimeout);
      if (!Number.isSafeInteger(lockTimeout) || lockTimeout < 1) {
        throw new ProjectException('无法读取 MySQL 会话的锁等待设置', 503);
      }
      try {
        await runner.query(setTimeoutSql, [IDEMPOTENCY_LOCK_TIMEOUT_MS / 1000]);
        return await runner.manager.transaction('READ COMMITTED', run);
      } finally {
        try {
          await runner.query(setTimeoutSql, [lockTimeout]);
        } catch (error) {
          // MySQL 的锁等待设置跟随物理连接，无法恢复时要丢弃这条连接。
          connection.destroy();
          this.logger.warn(`无法恢复 MySQL 幂等连接的锁等待设置，代码=${this.errorCode(error)}`);
        }
      }
    } finally {
      await runner.release();
    }
  }

  private async claim(
    manager: EntityManager,
    type: DatabaseType,
    key: string,
    fingerprint: string,
  ): Promise<boolean> {
    try {
      const claimed: unknown = await manager.query(idempotencySql[type].claim, [key, fingerprint]);
      // MySQL 的普通 INSERT 成功就取得主键，重复键只回滚当前语句。
      return type === 'mysql' || (Array.isArray(claimed) && claimed.length > 0);
    } catch (error) {
      const code = this.errorCode(error);
      if (type === 'mysql' && code === MYSQL_DUPLICATE_ENTRY) return false;
      if (code === POSTGRES_LOCK_NOT_AVAILABLE || MYSQL_RETRYABLE_LOCK_ERRORS.has(code)) {
        throw new ProjectException('幂等请求仍在处理中，请使用原幂等键重试', 503);
      }
      throw error;
    }
  }

  private async replay<T>(
    manager: EntityManager,
    type: DatabaseType,
    key: string,
    fingerprint: string,
  ): Promise<T> {
    const [row] = await manager.query<
      Array<{ request_hash: string; response_body: string | null }>
    >(idempotencySql[type].replay, [key]);
    if (!row || row.response_body === null) throw new ProjectException('幂等结果暂不可用', 503);
    if (row.request_hash !== fingerprint)
      throw new ProjectException('同一幂等键对应的请求参数不同', 409);
    return JSON.parse(row.response_body) as T;
  }

  private errorCode(error: unknown): string {
    return error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
  }
}
