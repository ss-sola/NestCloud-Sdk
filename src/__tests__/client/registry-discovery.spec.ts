import { Injectable, Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import axios from 'axios';
import { validateSync } from 'class-validator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnableAutoRegister } from '../../client/enable-registry-client.decorator';
import { RegistryClientService } from '../../client/registry-client.service';
import { REGISTER_RETRY_INTERVAL } from '../../client/registry-client.constants';
import type { ServiceInstance } from '../../client/registry-client.options';
import { setOptions } from '../../config-center/options';
import { ConfigKeys } from '../../config/keys';
import { CommonConfig } from '../../config/common.config';
import { ContextService } from '../../context/context.service';
import { RemoteCall } from '../../http/remote-call.decorator';
import { RemoteClientBase } from '../../http/remote-client.base';
import { RemoteService } from '../../http/remote-service.decorator';

const config = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../config-center', () => ({
  getConfig: (key: string, fallback?: unknown) => config.get(key) ?? fallback,
}));

@Injectable()
@RemoteService({ name: 'files', url: 'http://localhost:3300/dev-api' })
class FilesClient extends RemoteClientBase {
  @RemoteCall('/file/detail', 'GET')
  detail(query: { id: number }): Promise<unknown> {
    return this.self.detail(query);
  }
}

@EnableAutoRegister({ productionOnly: true })
@Module({ providers: [FilesClient] })
class HostModule {}

describe('服务注册与发现', () => {
  let app: INestApplicationContext | undefined;
  let records: Partial<ServiceInstance>[];

  beforeEach(() => {
    config.clear();
    config.set(ConfigKeys.NodeEnv, 'production');
    config.set(ConfigKeys.RegistryUrl, 'http://registry.internal:3100');
    config.set(ConfigKeys.ServiceName, 'files');
    config.set(ConfigKeys.ServiceHost, '10.0.0.7');
    config.set(ConfigKeys.Port, 3300);
    config.set(ConfigKeys.GlobalPrefix, '/api');
    setOptions({ AppModule: HostModule });
    records = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, data) => {
      if (url.endsWith('/register') && !records.length) records.push(data as ServiceInstance);
      return { data: { success: true } };
    });
    vi.spyOn(axios, 'get').mockImplementation(async () => ({ data: { data: { files: records } } }));
    vi.spyOn(axios, 'request').mockResolvedValue({ data: {} });
    vi.spyOn(ContextService, 'getReq').mockReturnValue({ headers: {} } as ReturnType<
      typeof ContextService.getReq
    >);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  async function start(): Promise<FilesClient> {
    app = await NestFactory.createApplicationContext(HostModule, {
      logger: false,
      abortOnError: false,
    });
    await app.get(RegistryClientService).afterApplicationBootstrap();
    return app.get(FilesClient);
  }

  it.each([
    [
      'https://middleware.example.com:8443/gateway/api/',
      'https://middleware.example.com:8443/gateway/api',
    ],
    [undefined, 'http://10.0.0.7:3300/api'],
  ])('注册并通过生产发现调用服务，地址配置为 %s', async (configured, base) => {
    if (configured) config.set(ConfigKeys.ServiceBaseUrl, configured);
    const client = await start();
    expect(records[0]).toMatchObject({
      id: 'files-10.0.0.7-3300',
      host: '10.0.0.7',
      port: 3300,
      baseUrl: configured ?? base,
    });
    await client.detail({ id: 7 });
    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({ url: `${base}/file/detail?id=7` }),
    );
  });

  it('兼容只有 host/port 的旧缓存记录', async () => {
    records.push({ id: 'old', name: 'files', host: '10.1.2.3', port: 8000 });
    const client = await start();
    await client.detail({ id: 7 });
    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://10.1.2.3:8000/file/detail?id=7' }),
    );
  });

  it('首次注册失败超过原有上限后仍按固定间隔重试，恢复后发送带鉴权的心跳', async () => {
    vi.useFakeTimers();
    const token = 'control-plane-test-token';
    const times: number[] = [];
    vi.mocked(axios.post).mockImplementation(async (url) => {
      if (url.endsWith('/register') && times.push(Date.now()) <= 6) throw new Error('不可用');
      return { data: { success: true } };
    });
    const registryUrl = 'http://registry.internal:3100';
    const client = new RegistryClientService({
      registryUrl,
      serviceName: 'files',
      serviceHost: '10.0.0.7',
      servicePort: 3300,
      controlPlaneToken: token,
      heartbeatInterval: 1_000,
    });
    const auth = expect.objectContaining({
      headers: { Authorization: `Bearer ${token}` },
      maxRedirects: 0,
    });
    try {
      const start = client.afterApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(REGISTER_RETRY_INTERVAL * 6);
      await start;
      expect(times).toHaveLength(7);
      expect(times.slice(1).map((time, index) => time - times[index])).toEqual(
        Array(6).fill(REGISTER_RETRY_INTERVAL),
      );
      expect(axios.post).toHaveBeenCalledWith(
        `${registryUrl}/api/registry/register`,
        expect.objectContaining({ heartbeatInterval: 1_000 }),
        auth,
      );
      expect(axios.get).toHaveBeenCalledWith(`${registryUrl}/api/registry/all`, auth);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(axios.post).toHaveBeenCalledWith(
        `${registryUrl}/api/registry/heartbeat/files-10.0.0.7-3300`,
        undefined,
        auth,
      );
    } finally {
      await client.onModuleDestroy();
      vi.useRealTimers();
    }
    expect(axios.post).toHaveBeenCalledWith(
      `${registryUrl}/api/registry/unregister/files-10.0.0.7-3300`,
      undefined,
      auth,
    );
  });

  it('心跳发现实例丢失后按相同间隔重试，关闭时取消重试', async () => {
    vi.useFakeTimers();
    const times: number[] = [];
    vi.mocked(axios.post).mockImplementation(async (url) => {
      if (url.endsWith('/register') && times.push(Date.now()) > 1) throw new Error('不可用');
      return { data: { success: !url.includes('/heartbeat/') } };
    });
    const client = new RegistryClientService({
      registryUrl: 'http://registry.internal:3100',
      serviceName: 'files',
      serviceHost: '10.0.0.7',
      servicePort: 3300,
      heartbeatInterval: 1_000,
    });
    try {
      await client.afterApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(1_000 + REGISTER_RETRY_INTERVAL);
      expect(times).toHaveLength(3);
      expect(times[2] - times[1]).toBe(REGISTER_RETRY_INTERVAL);
      await client.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(REGISTER_RETRY_INTERVAL * 2);
      expect(times).toHaveLength(3);
    } finally {
      await client.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('服务启动配置接受 HTTPS 前缀并拒绝将查询参数配置为基础路径', () => {
    const settings = Object.assign(new CommonConfig(), {
      ServiceName: 'files',
      Port: 3300,
      ServiceBaseUrl: 'https://gw.internal/api',
    });
    expect(validateSync(settings)).toEqual([]);
    settings.ServiceBaseUrl = 'https://gw.internal/api?stage=test';
    expect(validateSync(settings).map((error) => error.property)).toContain('ServiceBaseUrl');
  });

  it('本地开发仍使用固定地址，启动和关闭都不请求注册中心', async () => {
    config.set(ConfigKeys.NodeEnv, 'development');
    config.delete(ConfigKeys.RegistryUrl);
    const client = await start();
    await client.detail({ id: 7 });
    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://localhost:3300/dev-api/file/detail?id=7' }),
    );
    await app?.close();
    app = undefined;
    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });
});
