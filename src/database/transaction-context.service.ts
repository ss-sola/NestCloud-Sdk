import { AsyncLocalStorage } from 'node:async_hooks';
import { EntityManager, ObjectLiteral, Repository } from 'typeorm';
import { ProjectException } from '@/exception/global.exception';

/** 仅在显式受保护的业务回调中绑定事务，避免不同请求共享 EntityManager。 */
export class TransactionContextService {
  private static readonly storage = new AsyncLocalStorage<EntityManager>();

  static isActive(): boolean {
    return !!this.storage.getStore();
  }

  static run<T>(manager: EntityManager, work: () => Promise<T>): Promise<T> {
    return this.storage.run(manager, work);
  }

  static repositoryFor<T extends ObjectLiteral>(repository: Repository<T>): Repository<T> {
    const manager = this.storage.getStore();
    if (!manager) return repository;
    if (manager.connection !== repository.manager.connection) {
      throw new ProjectException('受保护的写操作无法跨数据库事务');
    }
    return manager.getRepository(repository.target);
  }
}
