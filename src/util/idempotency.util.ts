import { createHash } from 'node:crypto';
import { ProjectException } from '@/exception/global.exception';

export class IdempotencyUtil {
  /** 对与写入相关的已校验 JSON 做指纹，保留数组顺序，忽略对象属性顺序。 */
  static fingerprint(payload: unknown): string {
    let normalized: string | undefined;
    try {
      normalized = JSON.stringify(payload, (_key, value: unknown) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
        return Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        );
      });
    } catch {
      throw new ProjectException('幂等请求必须包含可序列化的 JSON 参数', 400);
    }
    if (normalized === undefined) throw new ProjectException('幂等请求缺少参数', 400);
    return this.digest(normalized);
  }

  static digest(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }
}
