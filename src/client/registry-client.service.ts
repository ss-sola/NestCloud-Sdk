// client/registry-client.service.ts
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import axios, { type AxiosRequestConfig } from 'axios';
import { RegistryClientOption, ServiceInstance } from './registry-client.options';
import {
  HEARTBEAT_INTERVAL,
  REGISTER_RETRY_INTERVAL,
  REGISTRY_CLIENT_OPTIONS,
  SYNC_INTERVAL,
} from './registry-client.constants';
import { AfterApplicationBootstrap } from '@/ext/after-application-bootstrap.interface';
import { DEFAULT_REMOTE_TIMEOUT } from '@/constants/http.constants';

import { isSameService } from '@/util/common.util';
import { ServiceAddressUtil } from '@/util/service-address.util';
import { enableAutoRegister } from './enable-registry-client.decorator';
import { getOptions } from '@/config-center/options';
import { ControlPlaneRequestUtil } from './control-plane-request.util';

@Injectable()
export class RegistryClientService implements AfterApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RegistryClientService.name);
  private readonly requestOptions: AxiosRequestConfig;
  private readonly heartbeatInterval: number;
  private instanceId: string;
  private heartbeatTimer?: NodeJS.Timeout;
  private syncTimer?: NodeJS.Timeout;
  private registrationAttempt?: Promise<void>;
  private registrationRetryTimer?: NodeJS.Timeout;
  private isHeartbeating = false;
  private registrationStarted = false;
  private roundRobinCounter = new Map<string, number>(); // 为每个服务维护一个轮询计数
  private cache = new Map<string, ServiceInstance[]>(); // 本地缓存

  constructor(
    @Inject(REGISTRY_CLIENT_OPTIONS)
    private readonly options: RegistryClientOption,
  ) {
    this.instanceId = `${options.serviceName}-${options.serviceHost}-${options.servicePort}`;
    this.heartbeatInterval = Number(options.heartbeatInterval ?? HEARTBEAT_INTERVAL);
    this.requestOptions = {
      timeout: DEFAULT_REMOTE_TIMEOUT,
      ...ControlPlaneRequestUtil.authOptions(options.controlPlaneToken),
    };
  }

  async afterApplicationBootstrap() {
    if (!enableAutoRegister(getOptions().AppModule)) return;
    // 如果注册中心地址是自己，则不注册
    const currentUrl = ServiceAddressUtil.httpOrigin(
      this.options.serviceHost,
      this.options.servicePort,
    );
    if (isSameService(currentUrl, this.options.registryUrl)) return;

    this.registrationStarted = true;
    // 注册自己
    await this.registerWithRetry();
    if (!this.registrationStarted) return;
    await this.syncServices(); // 启动时先拉一次
    if (!this.registrationStarted) return;

    // 定时同步服务列表
    const syncInterval = this.options.syncInterval ?? SYNC_INTERVAL;
    this.syncTimer = setInterval(() => this.syncServices(), syncInterval);
  }

  async onModuleDestroy() {
    if (!this.registrationStarted) return;
    this.registrationStarted = false;
    if (this.registrationRetryTimer) clearTimeout(this.registrationRetryTimer);
    this.stopHeartbeat();
    if (this.syncTimer) clearInterval(this.syncTimer);
    // 请求可能已到达注册中心，等待完成后下线，避免退出时留下活动实例。
    await this.registrationAttempt;
    await this.unregister();
  }

  // === 注册中心交互 ===
  private registerWithRetry(): Promise<void> | undefined {
    if (!this.registrationStarted || this.registrationAttempt || this.registrationRetryTimer) {
      return this.registrationAttempt;
    }

    this.registrationAttempt = this.register()
      .catch((error: unknown) => {
        if (!this.registrationStarted) return;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Register failed for ${this.instanceId}, retrying in ${REGISTER_RETRY_INTERVAL} ms: ${message}`,
        );
        this.registrationRetryTimer = setTimeout(() => {
          this.registrationRetryTimer = undefined;
          void this.registerWithRetry();
        }, REGISTER_RETRY_INTERVAL);
      })
      .finally(() => {
        this.registrationAttempt = undefined;
      });
    return this.registrationAttempt;
  }

  private async register() {
    await axios.post(
      `${this.options.registryUrl}/api/registry/register`,
      {
        id: this.instanceId,
        name: this.options.serviceName,
        host: this.options.serviceHost,
        port: this.options.servicePort,
        baseUrl: this.options.serviceBaseUrl,
        heartbeatInterval: this.heartbeatInterval,
        metadata: this.options.metadata,
      },
      this.requestOptions,
    );
    this.logger.log(`Registered as ${this.instanceId}`);

    if (this.registrationStarted) this.startHeartbeat();
  }

  private async unregister() {
    try {
      await axios.post(
        `${this.options.registryUrl}/api/registry/unregister/${this.instanceId}`,
        undefined,
        this.requestOptions,
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
      const res = await axios.post<{ success: boolean }>(
        `${this.options.registryUrl}/api/registry/heartbeat/${this.instanceId}`,
        undefined,
        this.requestOptions,
      );
      const heartbeatResult = unwrapResponsePayload<{ success: boolean }>(res.data);

      if (!heartbeatResult.success) {
        this.stopHeartbeat();
        await this.registerWithRetry(); // 如果心跳返回false，说明实例不存在，重新注册
      }
      this.logger.debug(`Heartbeat ${this.instanceId} ${heartbeatResult.success}`);
    } catch (err: any) {
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

  private async syncServices() {
    try {
      const res = await axios.get(
        `${this.options.registryUrl}/api/registry/all`,
        this.requestOptions,
      );
      const serviceMap = unwrapResponsePayload<Record<string, ServiceInstance[]>>(res.data);

      const newCache = new Map<string, ServiceInstance[]>();
      for (const key in serviceMap) {
        newCache.set(key, serviceMap[key]);
      }

      this.cache = newCache; // 只有成功时才替换
      this.logger.debug(`服务实例已同步到本地缓存: ${JSON.stringify(serviceMap)}`);
    } catch (err: any) {
      this.logger.error(
        `Sync services failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  // === 本地服务发现 ===
  getInstances(serviceName: string): ServiceInstance[] {
    return this.cache.get(serviceName) ?? [];
  }

  listServices(): Array<{
    serviceName: string;
    instances: ServiceInstance[];
  }> {
    return [...this.cache.entries()].map(([serviceName, instances]) => ({
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
