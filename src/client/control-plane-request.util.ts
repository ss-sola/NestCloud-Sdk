import type { AxiosRequestConfig } from 'axios';

export class ControlPlaneRequestUtil {
  static authOptions(token?: string): Pick<AxiosRequestConfig, 'headers' | 'maxRedirects'> {
    if (!token) return {};
    return {
      headers: { Authorization: `Bearer ${token}` },
      maxRedirects: 0,
    };
  }
}
