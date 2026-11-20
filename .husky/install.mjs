import { existsSync } from 'node:fs';

if (
  process.env.HUSKY !== '0' &&
  process.env.NODE_ENV !== 'production' &&
  process.env.npm_config_production !== 'true' &&
  existsSync('.git') &&
  existsSync('.husky/pre-commit') &&
  existsSync('node_modules/husky/package.json')
) {
  const { default: install } = await import('husky');
  const error = install();
  if (error) throw new Error(error);
}
