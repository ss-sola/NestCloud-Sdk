import { Injectable, Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import axios from 'axios';
import { validateSync } from 'class-validator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnableAutoRegister } from '../../client/enable-registry-client.decorator';
import { RegistryClientService } from '../../client/registry-client.service';
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
