// client/registry-client.service.ts
import { HttpStatus, Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import axios from 'axios';
import { z } from 'zod';
import { RegistryClientOption, ServiceInstance } from './registry-client.options';
import {
  DISCOVERY_CACHE_MAX_AGE_INTERVALS,
  HEARTBEAT_INTERVAL,
  MAX_REREGISTER_INTERVAL,
  MAX_SYNC_INTERVAL,
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
import { ProjectException } from '@/exception/global.exception';
import {
  parseControlPlaneToken,
  parseRegistryUrls,
  RegistryEndpoints,
} from './control-plane-request.util';

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
export class RegistryClientService implements AfterApplicationBootstrap, OnModuleDestroy {
  private readonly endpoints: RegistryEndpoints;
  private readonly logger = new Logger(RegistryClientService.name);
  private readonly token?: string | string[];
  private readonly heartbeatInterval: number;
  private readonly syncInterval: number;
  private readonly shutdown = new AbortController();
  private instanceId: string;
  private heartbeatTimer?: NodeJS.Timeout;
  private syncTimer?: NodeJS.Timeout;
  private syncing = false;
  private syncTask?: Promise<void>;
  private lastSyncAt?: number;
  private registrationAttempt?: Promise<void>;
  private registrationRetryTimer?: NodeJS.Timeout;
  private isHeartbeating = false;
  private registrationStarted = false;
  private roundRobinCounter = new Map<string, number>(); // 为每个服务维护一个轮询计数
  private cache?: { services: Map<string, ServiceInstance[]>; expiresAt: number };

  constructor(
    @Inject(REGISTRY_CLIENT_OPTIONS)
    private readonly options: RegistryClientOption,
  ) {
    this.endpoints = new RegistryEndpoints(
      options.registryUrl ? parseRegistryUrls(options.registryUrl) : [],
    );
    this.instanceId = `${options.serviceName}-${options.serviceHost}-${options.servicePort}`;
    this.heartbeatInterval = Number(options.heartbeatInterval ?? HEARTBEAT_INTERVAL);
    const syncInterval = Number(options.syncInterval ?? SYNC_INTERVAL);
    this.syncInterval =
      Number.isInteger(syncInterval) && syncInterval >= 1 && syncInterval <= MAX_SYNC_INTERVAL
        ? syncInterval
        : SYNC_INTERVAL;
    this.token =
      options.controlPlaneToken === undefined
        ? undefined
        : parseControlPlaneToken(options.controlPlaneToken);
  }

  async afterApplicationBootstrap() {
    if (this.options.discoveryOnly) {
      await this.startServiceSync();
      return;
    }
    if (!enableAutoRegister(getOptions().AppModule)) return;
    // 如果注册中心地址是自己，则不注册
    const currentUrl = ServiceAddressUtil.httpOrigin(
      this.options.serviceHost,
      this.options.servicePort,
    );
    if (this.endpoints.urls.some((url) => isSameService(currentUrl, url))) return;

    this.registrationStarted = true;
    // 注册自己
    await this.registerWithRetry();
    if (!this.registrationStarted) return;
    await this.startServiceSync();
  }

  async onModuleDestroy() {
    if (this.shutdown.signal.aborted) return;
    this.shutdown.abort();
    this.syncing = false;
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (!this.registrationStarted) return;
    this.registrationStarted = false;
    if (this.registrationRetryTimer) clearTimeout(this.registrationRetryTimer);
    this.stopHeartbeat();
    // 请求可能已到达注册中心，等待完成后下线，避免退出时留下活动实例。
    await this.registrationAttempt;
    await this.unregister();
  }

  // === 注册中心交互 ===
  private registerWithRetry(backoffInterval?: number): Promise<void> | undefined {
    if (!this.registrationStarted || this.registrationAttempt || this.registrationRetryTimer) {
      return this.registrationAttempt;
    }

    this.registrationAttempt = this.register()
      .catch((error: unknown) => {
        if (!this.registrationStarted) return;
        const message = error instanceof Error ? error.message : String(error);
        const delay = backoffInterval ?? REGISTER_RETRY_INTERVAL;
        const jitter =
          backoffInterval === undefined
            ? 0
            : Math.floor(delay * REREGISTER_JITTER_RATIO * Math.random());
        const retryDelay = delay - jitter;
        const nextBackoff =
          backoffInterval === undefined ? undefined : Math.min(delay * 2, MAX_REREGISTER_INTERVAL);
        this.logger.warn(
          `Register failed for ${this.instanceId}, retrying in ${retryDelay} ms: ${message}`,
        );
        this.registrationRetryTimer = setTimeout(() => {
          this.registrationRetryTimer = undefined;
          void this.registerWithRetry(nextBackoff);
        }, retryDelay);
      })
      .finally(() => {
        this.registrationAttempt = undefined;
      });
    return this.registrationAttempt;
  }

  private async register() {
    await this.endpoints.request(
      (url, requestOptions) =>
        axios.post(
          `${url}/api/registry/register`,
          {
            id: this.instanceId,
            name: this.options.serviceName,
            host: this.options.serviceHost,
            port: this.options.servicePort,
            baseUrl: this.options.serviceBaseUrl,
            heartbeatInterval: this.heartbeatInterval,
            metadata: this.options.metadata,
          },
          requestOptions,
        ),
      this.token,
    );
    this.logger.log(`Registered as ${this.instanceId}`);

    if (this.registrationStarted) this.startHeartbeat();
  }

  private async unregister() {
    try {
      await this.endpoints.request(
        (url, requestOptions) =>
          axios.post(
            `${url}/api/registry/unregister/${this.instanceId}`,
            undefined,
            requestOptions,
          ),
        this.token,
      );
      this.logger.log(`Unregistered ${this.instanceId}`);
    } catch (err: any) {
      this.logger.error(
        `Unregister failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  private async heartbeat() {
    if (!this.registrationStarted || this.isHeartbeating) return;
    this.isHeartbeating = true;
    try {
      const res = await this.endpoints.request(
        (url, requestOptions) =>
          axios.post<{ success: boolean }>(
            `${url}/api/registry/heartbeat/${this.instanceId}`,
            undefined,
            { ...requestOptions, signal: this.shutdown.signal },
          ),
        this.token,
      );
      const heartbeatResult = unwrapResponsePayload<{ success: boolean }>(res.data);

      if (this.shutdown.signal.aborted) return;
      if (typeof heartbeatResult?.success !== 'boolean') {
        throw new Error('Invalid registry heartbeat response');
      }
      if (heartbeatResult.success === false) {
        this.stopHeartbeat();
        await this.registerWithRetry(REGISTER_RETRY_INTERVAL);
      }
      this.logger.debug(`Heartbeat ${this.instanceId} ${heartbeatResult.success}`);
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

    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatInterval);
  }

  private stopHeartbeat() {
    if (!this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private async startServiceSync() {
    if (this.syncing || this.shutdown.signal.aborted) return;
    this.syncing = true;
    await this.refreshServices();
    if (!this.syncing) return;
    this.syncTimer = setInterval(() => void this.refreshServices(), this.syncInterval);
  }

  private refreshServices() {
    this.syncTask ??= this.syncServices().finally(() => {
      this.syncTask = undefined;
    });
    return this.syncTask;
  }

  private async syncServices() {
    try {
      const res = await this.endpoints.request(
        (url, requestOptions) =>
          axios.get<unknown>(`${url}/api/registry/all`, {
            ...requestOptions,
            signal: this.shutdown.signal,
          }),
        this.token,
      );
      if (!this.syncing) return;
      const snapshot = discoveryResponseSchema.safeParse(res.data);
      if (!snapshot.success) {
        throw new Error('Invalid registry service list');
      }

      this.cache = {
        services: new Map(Object.entries(snapshot.data)),
        expiresAt: performance.now() + this.syncInterval * DISCOVERY_CACHE_MAX_AGE_INTERVALS,
      };
      this.lastSyncAt = Date.now();
      this.logger.debug(`服务实例已同步到本地缓存: ${JSON.stringify(snapshot.data)}`);
    } catch (err: unknown) {
      if (this.shutdown.signal.aborted) return;
      this.logger.error(
        `Sync services failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
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

  getLastSyncAt(): number | undefined {
    return this.lastSyncAt;
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

function unwrapResponsePayload<T>(payload: any): T {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return payload.data as T;
  }

  return payload as T;
}
