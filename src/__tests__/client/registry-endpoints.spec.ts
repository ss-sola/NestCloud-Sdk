import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import axios from 'axios';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRegistryUrls, RegistryEndpoints } from '../../client/control-plane-request.util';

describe('RegistryUrl 节点切换', () => {
  const servers: Server[] = [];
  const hits: number[] = [];

  async function listen(status: number) {
    const server = createServer((_req, res) => {
      hits.push(status);
      res.writeHead(status).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  }

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
    hits.length = 0;
  });

  it('首节点故障后切换，后续请求沿用成功的节点', async () => {
    const urls = [await listen(503), await listen(200)];
    const endpoints = new RegistryEndpoints(parseRegistryUrls(JSON.stringify(urls)));
    await endpoints.request((url) => axios.post(url));
    await endpoints.request((url) => axios.get(url));
    expect(hits).toEqual([503, 200, 200]);
  });

  it('鉴权失败时返回错误', async () => {
    const endpoints = new RegistryEndpoints([await listen(401), await listen(200)]);
    await expect(endpoints.request((url) => axios.get(url))).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(hits).toEqual([401]);
  });

  it('支持旧单地址，拒绝空数组与包含无效地址的数组', () => {
    expect(parseRegistryUrls('http://registry-a/')).toEqual(['http://registry-a']);
    expect(() => parseRegistryUrls('[]')).toThrow();
    expect(() => parseRegistryUrls(['http://registry-a', 'bad'])).toThrow();
  });
});
