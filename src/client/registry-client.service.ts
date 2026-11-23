// client/registry-client.service.ts
import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import axios from 'axios';
import { z } from 'zod';
import { RegistryClientOption, ServiceInstance } from './registry-client.options';
import {
  DISCOVERY_CACHE_MAX_AGE_INTERVALS,
  HEARTBEAT_INTERVAL,
  MAX_REREGISTER_INTERVAL,
  MAX_SYNC_INTERVAL,
  REGISTER_MAX_RETRIES,
  REGISTER_RETRY_INTERVAL,
  REGISTRY_CLIENT_OPTIONS,
  REREGISTER_JITTER_RATIO,
  SYNC_INTERVAL,
} from './registry-client.constants';
import { AfterApplicationBootstrap } from '@/ext/after-application-bootstrap.interface';

import { isSameService } from '@/util/common.util';
import { ServiceAddressUtil } from '@/util/service-address.util';
import { enableAutoRegister } from './enable-registry-client.decorator';
import { getOptions } from '@/config-center/options';
import { DEFAULT_REMOTE_TIMEOUT } from '@/constants/http.constants';
import { ProjectException } from '@/exception/global.exception';

const serviceMapSchema = z.record(
  z.string(),
  z.array(
    z.looseObject({
      id: z.string().min(1),
      name: z.string().min(1),
      host: z.string().min(1),
      port: z.int().min(1).max(65_535),
      lastHeartbeat: z.number(),
      baseUrl: z
        .string()
        .nullish()
        .transform((value) => value ?? undefined),
      group: z
        .string()
        .nullish()
        .transform((value) => value ?? undefined),
      metadata: z
        .record(z.string(), z.unknown())
        .nullish()
        .transform((value) => value ?? undefined),
    }),
  ),
);
const discoveryResponseSchema = z.union([
  z
    .object({ code: z.literal(200).optional(), data: serviceMapSchema })
    .transform(({ data }) => data),
  serviceMapSchema,
]);

@Injectable()
export class RegistryClientService
  implements OnApplicationBootstrap, AfterApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RegistryClientService.name);
  private readonly instanceId: string;
  private readonly syncInterval: number;
  private readonly shutdown = new AbortController();
  private heartbeatTimer?: NodeJS.Timeout;
  private reregisterTimer?: NodeJS.Timeout;
  private syncTimer?: NodeJS.Timeout;
  private isRegistering = false;
  private isHeartbeating = false;
  private registered = false;
  private isSyncing = false;
  private roundRobinCounter = new Map<string, number>(); // 为每个服务维护一个轮询计数
  private cache?: { services: Map<string, ServiceInstance[]>; expiresAt: number };

  constructor(
    @Inject(REGISTRY_CLIENT_OPTIONS)
    private readonly options: RegistryClientOption,
  ) {
    this.instanceId = `${options.serviceName}-${options.serviceHost}-${options.servicePort}`;
    const syncInterval = Number(options.syncInterval ?? SYNC_INTERVAL);
    this.syncInterval =
      Number.isInteger(syncInterval) && syncInterval >= 1 && syncInterval <= MAX_SYNC_INTERVAL
        ? syncInterval
        : SYNC_INTERVAL;
  }

  async onApplicationBootstrap() {
    if (!enableAutoRegister(getOptions().AppModule)) return;
    // 如果注册中心地址是自己，则不注册
    const currentUrl = ServiceAddressUtil.httpOrigin(
      this.options.serviceHost,
      this.options.servicePort,
    );
    if (isSameService(currentUrl, this.options.registryUrl)) return;

    // Nest 在监听端口前等待首次注册完成。注册失败由 SDK 启动入口退出进程。
    await this.registerWithRetry();
  }

  async afterApplicationBootstrap() {
    if (!this.registered) return;
    await this.syncServices(); // 启动时先拉一次
    if (this.shutdown.signal.aborted) return;

    // 定时同步服务列表
    this.syncTimer = setInterval(() => this.syncServices(), this.syncInterval);
  }

  async onModuleDestroy() {
    this.shutdown.abort();
    this.stopHeartbeat();
    if (this.reregisterTimer) {
      clearTimeout(this.reregisterTimer);
      this.reregisterTimer = undefined;
    }
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.registered) await this.unregister();
  }

  // === 注册中心交互 ===
  private async registerWithRetry() {
    if (this.isRegistering) {
      return;
    }

    this.isRegistering = true;

    try {
      for (let attempt = 1; attempt <= REGISTER_MAX_RETRIES; attempt += 1) {
        try {
          await this.register();
          return;
        } catch (err: unknown) {
          if (this.shutdown.signal.aborted) throw err;
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : undefined;

          this.logger.error(
            `Register failed (${attempt}/${REGISTER_MAX_RETRIES}): ${message}`,
            stack,
          );

          if (attempt >= REGISTER_MAX_RETRIES) {
            throw new Error(
              `Register aborted after ${REGISTER_MAX_RETRIES} attempts: ${this.instanceId}`,
              { cause: err },
            );
          }

          await delay(REGISTER_RETRY_INTERVAL);
        }
      }
    } finally {
      this.isRegistering = false;
    }
  }

  private async register() {
    const signal = this.registryRequestSignal();
    signal.throwIfAborted();
    await axios.post(
      `${this.options.registryUrl}/api/registry/register`,
      {
        id: this.instanceId,
        name: this.options.serviceName,
        host: this.options.serviceHost,
        port: this.options.servicePort,
        baseUrl: this.options.serviceBaseUrl,
        metadata: this.options.metadata,
      },
      { signal },
    );
    this.shutdown.signal.throwIfAborted();
    this.registered = true;
    this.logger.log(`Registered as ${this.instanceId}`);

    this.startHeartbeat();
  }

  private async reregister(retryInterval: number) {
    if (this.shutdown.signal.aborted) return;

    try {
      await this.register();
    } catch (err: unknown) {
      if (this.shutdown.signal.aborted) return;

      const jitter = Math.floor(retryInterval * REREGISTER_JITTER_RATIO * Math.random());
      const retryDelay = retryInterval - jitter;
      const nextInterval = Math.min(retryInterval * 2, MAX_REREGISTER_INTERVAL);
      this.logger.warn(
        `Re-register failed for ${this.instanceId}; retrying in ${retryDelay}ms: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.reregisterTimer = setTimeout(() => {
        this.reregisterTimer = undefined;
        void this.reregister(nextInterval);
      }, retryDelay);
    }
  }

  private async unregister() {
    try {
      await axios.post(
        `${this.options.registryUrl}/api/registry/unregister/${this.instanceId}`,
        undefined,
        {
          signal: AbortSignal.timeout(DEFAULT_REMOTE_TIMEOUT),
        },
      );
      this.logger.log(`Unregistered ${this.instanceId}`);
    } catch (err: unknown) {
      this.logger.error(
        `Unregister failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  private registryRequestSignal() {
    return AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(DEFAULT_REMOTE_TIMEOUT)]);
  }

  private async heartbeat() {
    if (this.isHeartbeating || this.shutdown.signal.aborted) return;
    this.isHeartbeating = true;

    try {
      const res = await axios.post<{ success: boolean }>(
        `${this.options.registryUrl}/api/registry/heartbeat/${this.instanceId}`,
        undefined,
        { signal: this.registryRequestSignal() },
      );
      const heartbeatResult = unwrapResponsePayload<{ success: boolean }>(res.data);

      if (typeof heartbeatResult?.success !== 'boolean') {
        throw new Error('Invalid registry heartbeat response');
      }
      this.logger.debug(`Heartbeat ${this.instanceId} ${heartbeatResult.success}`);
      if (heartbeatResult.success === false) {
        this.stopHeartbeat();
        await this.reregister(REGISTER_RETRY_INTERVAL);
      }
    } catch (err: unknown) {
      if (this.shutdown.signal.aborted) return;
      this.logger.error(
        `Heartbeat failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    } finally {
      this.isHeartbeating = false;
    }
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) {
      return;
    }

    const interval = this.options.heartbeatInterval ?? HEARTBEAT_INTERVAL;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), interval);
  }

  private stopHeartbeat() {
    if (!this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private async syncServices() {
    if (this.isSyncing || this.shutdown.signal.aborted) return;
    this.isSyncing = true;

    try {
      const res = await axios.get<unknown>(`${this.options.registryUrl}/api/registry/all`, {
        signal: this.registryRequestSignal(),
      });
      if (this.shutdown.signal.aborted) return;
      const snapshot = discoveryResponseSchema.safeParse(res.data);
      if (!snapshot.success) {
        throw new Error('Invalid registry service list');
      }

      this.cache = {
        services: new Map(Object.entries(snapshot.data)),
        expiresAt: performance.now() + this.syncInterval * DISCOVERY_CACHE_MAX_AGE_INTERVALS,
      };
      this.logger.debug(`服务实例已同步到本地缓存: ${JSON.stringify(snapshot.data)}`);
    } catch (err: unknown) {
      if (this.shutdown.signal.aborted) return;
      this.logger.error(
        `Sync services failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    } finally {
      this.isSyncing = false;
    }
  }

  // === 本地服务发现 ===
  getInstances(serviceName: string, { requireFresh = false } = {}): ServiceInstance[] {
    const services = this.getFreshServices();
    if (!services && requireFresh) {
      throw new ProjectException('服务发现暂不可用', HttpStatus.SERVICE_UNAVAILABLE);
    }
    return services?.get(serviceName) ?? [];
  }

  private getFreshServices() {
    if (this.cache && performance.now() >= this.cache.expiresAt) {
      this.cache = undefined;
    }
    return this.cache?.services;
  }

  listServices(): Array<{
    serviceName: string;
    instances: ServiceInstance[];
  }> {
    return [...(this.getFreshServices()?.entries() ?? [])].map(([serviceName, instances]) => ({
      serviceName,
      instances: [...instances],
    }));
  }

  getInstance(
    serviceName: string,
    strategy: 'random' | 'roundRobin' = 'random',
  ): ServiceInstance | null {
    const instances = this.getInstances(serviceName);
    if (!instances.length) return null;

    if (strategy === 'random') {
      return instances[Math.floor(Math.random() * instances.length)];
    }

    if (strategy === 'roundRobin') {
      const counter = this.roundRobinCounter.get(serviceName) ?? 0;
      const instance = instances[counter % instances.length];
      this.roundRobinCounter.set(serviceName, counter + 1);
      return instance;
    }

    return instances[0];
  }
}

function delay(timeout: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

function unwrapResponsePayload<T>(payload: any): T {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return payload.data as T;
  }

  return payload as T;
}
