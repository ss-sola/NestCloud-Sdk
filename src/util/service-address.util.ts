import { isIPv6 } from 'node:net';
import { getDefaultPort } from './common.util';

/** 注册端和消费端共同使用的实例地址拼接规则。 */
export class ServiceAddressUtil {
  static portOf(url: URL): number {
    return Number(url.port || getDefaultPort(url.protocol));
  }

  static httpOrigin(host: string, port: number): string {
    const hostname = isIPv6(host) ? `[${host}]` : host;
    return `http://${hostname}:${port}`;
  }

  static join(baseUrl: string, route: string): string {
    const base = baseUrl.replace(/\/+$/, '');
    if (!route) return base;
    return `${base}/${route.replace(/^\/+/, '')}`;
  }
}
