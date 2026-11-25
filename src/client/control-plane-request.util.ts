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
  return [...new Set(origins)];
}

export class RegistryEndpoints {
  private preferred = 0;

  constructor(readonly urls: string[]) {}

  async request<T>(send: (origin: string) => Promise<T>): Promise<T> {
    const start = this.preferred;
    for (let offset = 0; offset < this.urls.length; offset++) {
      const index = (start + offset) % this.urls.length;
      try {
        const result = await send(this.urls[index]);
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
