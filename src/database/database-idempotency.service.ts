import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { ContextService } from '@/context/context.service';
import {
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_LOCK_TIMEOUT_MS,
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
    if (this.dataSource.options.type !== 'postgres')
      throw new ProjectException('幂等写入需要 PostgreSQL', 503);
    if (TransactionContextService.isActive()) throw new ProjectException('不可嵌套开启幂等事务');

    const key = IdempotencyUtil.digest(
      JSON.stringify([input.operation, input.principal, input.key]),
    );
    const fingerprint = IdempotencyUtil.fingerprint(input.payload);
    let businessFailure: { error: unknown } | undefined;
    try {
      return await this.dataSource.transaction('READ COMMITTED', async (manager) => {
        await manager.query("SELECT set_config('lock_timeout', $1, true)", [
          `${IDEMPOTENCY_LOCK_TIMEOUT_MS}ms`,
        ]);
        // 并发 INSERT 会等待同一唯一键的持有事务提交或回滚。下一条语句看到新的已提交快照。
        if (!(await this.claim(manager, key, fingerprint))) {
          return this.replay<T>(manager, key, fingerprint);
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
        await manager.query(
          'UPDATE rpc_idempotency_record SET response_body = $2 WHERE operation_key = $1',
          [key, body],
        );
        return result;
      });
    } catch (error) {
      if (businessFailure?.error === error || error instanceof ProjectException) throw error;
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
      this.logger.error(`幂等事务失败，操作=${input.operation}，代码=${code}`);
      throw new ProjectException('幂等存储暂不可用，请使用原幂等键重试', 503);
    }
  }

  private async claim(manager: EntityManager, key: string, fingerprint: string): Promise<boolean> {
    try {
      const claimed: unknown[] = await manager.query(
        'INSERT INTO rpc_idempotency_record (operation_key, request_hash) VALUES ($1, $2) ' +
          'ON CONFLICT (operation_key) DO NOTHING RETURNING operation_key',
        [key, fingerprint],
      );
      return claimed.length > 0;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === POSTGRES_LOCK_NOT_AVAILABLE) {
        throw new ProjectException('幂等请求仍在处理中，请使用原幂等键重试', 503);
      }
      throw error;
    }
  }

  private async replay<T>(manager: EntityManager, key: string, fingerprint: string): Promise<T> {
    const [row] = await manager.query<
      Array<{ request_hash: string; response_body: string | null }>
    >('SELECT request_hash, response_body FROM rpc_idempotency_record WHERE operation_key = $1', [
      key,
    ]);
    if (!row || row.response_body === null) throw new ProjectException('幂等结果暂不可用', 503);
    if (row.request_hash !== fingerprint)
      throw new ProjectException('同一幂等键对应的请求参数不同', 409);
    return JSON.parse(row.response_body) as T;
  }
}
