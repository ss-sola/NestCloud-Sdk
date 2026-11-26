import { DEFAULT_REMOTE_TIMEOUT } from '@/constants/http.constants';
import axios, { type AxiosRequestConfig } from 'axios';

export class ControlPlaneRequestUtil {
  static authOptions(token?: string): Pick<AxiosRequestConfig, 'headers' | 'maxRedirects'> {
    if (!token) return {};
    return {
      headers: { Authorization: `Bearer ${token}` },
      maxRedirects: 0,
    };
  }
}

export function parseControlPlaneToken(value: unknown): string | string[] {
  if (typeof value === 'string' && value.trimStart().startsWith('[')) {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error('ControlPlaneToken must be a valid JSON array');
    }
  }
  const valid = (token: unknown): token is string =>
    typeof token === 'string' && /^(?:[A-Za-z0-9._~+/-]+=*)?$/.test(token);
  if (valid(value) || (Array.isArray(value) && value.length && value.every(valid))) return value;
  throw new Error('Invalid ControlPlaneToken');
}

export function validateTokenCount(urls: string[], token?: string | string[]) {
  if (Array.isArray(token) && token.length !== urls.length) {
    throw new Error('ControlPlaneToken and RegistryUrl arrays must have the same length');
  }
}

export function parseRegistryUrls(value: unknown): string[] {
  if (typeof value === 'string') {
    const raw = value.trim();
    value = raw.startsWith('[') ? JSON.parse(raw) : [raw];
  }
  if (!Array.isArray(value) || !value.length) {
    throw new Error('RegistryUrl must contain at least one HTTP(S) origin');
  }
  const origins = value.map((entry: unknown) => {
    if (typeof entry !== 'string') throw new Error('Invalid RegistryUrl entry');
    const url = new URL(entry);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error('RegistryUrl must contain HTTP(S) origins');
    }
    return url.origin;
  });
  return origins;
}

export class RegistryEndpoints {
  private preferred = 0;

  constructor(readonly urls: string[]) {}

  async request<T>(
    send: (
      origin: string,
      options: Pick<AxiosRequestConfig, 'timeout' | 'headers' | 'maxRedirects'>,
    ) => Promise<T>,
    token?: string | string[],
  ): Promise<T> {
    validateTokenCount(this.urls, token);
    const start = this.preferred;
    for (let offset = 0; offset < this.urls.length; offset++) {
      const index = (start + offset) % this.urls.length;
      try {
        const result = await send(this.urls[index], {
          timeout: DEFAULT_REMOTE_TIMEOUT,
          ...ControlPlaneRequestUtil.authOptions(Array.isArray(token) ? token[index] : token),
        });
        this.preferred = index;
        return result;
      } catch (error) {
        if (
          offset + 1 === this.urls.length ||
          !axios.isAxiosError(error) ||
          (error.response && error.response.status < 500) ||
          axios.isCancel(error)
        )
          throw error;
      }
    }
    throw new Error('Missing RegistryUrl');
  }
}
