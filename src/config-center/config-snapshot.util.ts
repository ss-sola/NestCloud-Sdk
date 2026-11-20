import { plainToInstance } from 'class-transformer';
import {
  getMetadataStorage,
  IS_BOOLEAN,
  validateSync,
  type ValidationError,
} from 'class-validator';
import { ProjectException } from '@/exception/global.exception';
import { ConfigKeys } from '@/config/keys';

type ConfigValues = Record<string, any>;

/** 在独立候选快照上完成配置合并与 DTO 类型转换。 */
export class ConfigSnapshotUtil {
  static isObject(value: unknown): value is ConfigValues {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  static merge(base: ConfigValues, overrides: ConfigValues): ConfigValues {
    const result = { ...base, ...overrides };
    for (const [key, value] of Object.entries(overrides)) {
      if (Object.hasOwn(base, key) && this.isObject(base[key]) && this.isObject(value)) {
        result[key] = this.merge(base[key], value);
      }
    }
    return result;
  }

  static validate<T extends object>(configClass: new () => T, candidate: ConfigValues): T {
    const raw = { ...candidate };
    // class-transformer 会把非空字符串 'false' 隐式转成 true，先按 DTO 的布尔声明解析原始值。
    const metadata = getMetadataStorage().getTargetValidationMetadatas(
      configClass,
      '',
      false,
      false,
    );
    for (const field of metadata) {
      const key = field.propertyName;
      const isSessionCredential =
        key === ConfigKeys.SessionSecret || key === ConfigKeys.SessionRedisUrl;
      if (isSessionCredential && raw[key] === undefined && process.env[key] !== undefined) {
        raw[key] = process.env[key];
      }
      if (field.name === IS_BOOLEAN && raw[key] != null) {
        raw[key] = this.toBoolean(key, raw[key]);
      }
    }
    const instance = plainToInstance(configClass, raw, { enableImplicitConversion: true });
    const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: false });
    if (errors.length) {
      throw new ProjectException(
        `Config validation failed: ${this.formatErrors(errors).join('; ')}`,
      );
    }
    return instance;
  }

  static toBoolean(key: string, value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
    if (normalized === 'true' || normalized === '1' || normalized === 1) return true;
    if (normalized === 'false' || normalized === '0' || normalized === 0) return false;
    throw new ProjectException(`Config key type invalid: ${key} must be a boolean`);
  }

  private static formatErrors(errors: ValidationError[], parentPath = ''): string[] {
    return errors.flatMap((error) => {
      const path = parentPath ? `${parentPath}.${error.property}` : error.property;
      const messages = Object.values(error.constraints ?? {}).map(
        (message) => `${path}: ${message}`,
      );
      return [...messages, ...this.formatErrors(error.children ?? [], path)];
    });
  }
}
