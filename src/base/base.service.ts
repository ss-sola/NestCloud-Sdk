// src/common/services/base.service.ts
import { Repository, FindManyOptions, FindOptionsWhere, DeepPartial } from 'typeorm';
import { BaseEntity } from './base.entity';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { PageCommon } from '@/page/page.vo';
import { ContextService } from '@/context/context.service';
import { TransactionContextService } from '@/database/transaction-context.service';

export abstract class BaseService<T extends BaseEntity> {
  constructor(protected readonly repository: Repository<T>) {}

  /** 自定义查询也可通过此入口使用当前业务事务。 */
  protected get entityRepository(): Repository<T> {
    return TransactionContextService.repositoryFor(this.repository);
  }

  async findAll(options?: FindManyOptions<T>) {
    return this.entityRepository.find({
      where: {
        ...options?.where,
      },
      ...options,
    });
  }

  async findOne(id: number): Promise<T | null> {
    return this.entityRepository.findOne({
      where: { id } as FindOptionsWhere<T>,
    });
  }

  async create(data: DeepPartial<T>): Promise<T> {
    const repository = this.entityRepository;
    const entity = repository.create(data);
    this.applyCreateAudit(entity);
    return repository.save(entity);
  }

  async update(id: number, data: DeepPartial<T>): Promise<T | null> {
    const repository = this.entityRepository;
    const entity = repository.create(data);
    this.applyUpdateAudit(entity);
    await repository.update(id, entity as QueryDeepPartialEntity<T>);
    return this.findOne(id);
  }

  async delete(id: number): Promise<void> {
    await this.entityRepository.softDelete(id);
  }

  protected applyCreateAudit(entity: T): void {
    const accountId = this.getCurrentAccountId();
    if (!accountId) {
      return;
    }
    entity.createUser = entity.createUser ?? accountId;
    entity.updateUser = entity.updateUser ?? accountId;
  }

  protected applyUpdateAudit(entity: T): void {
    const accountId = this.getCurrentAccountId();
    if (!accountId) {
      return;
    }
    entity.updateUser = accountId;
  }

  private getCurrentAccountId(): number | undefined {
    try {
      return ContextService.getCurrentAccount().accountId;
    } catch {
      return undefined;
    }
  }

  async paginate(pageCommon: PageCommon, extraOptions: FindManyOptions<T> = {}) {
    const [items, total] = await this.entityRepository.findAndCount({
      where: {
        ...extraOptions.where,
      },
      skip: (pageCommon.pageNum - 1) * pageCommon.pageSize,
      take: pageCommon.pageSize,
      ...extraOptions,
    });

    return {
      list: items,
      total,
      ...pageCommon,
    };
  }
}
