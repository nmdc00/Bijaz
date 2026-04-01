import { describe, expect, it } from 'vitest';
import { resolveGatewayLaunch } from '../../src/cli/gateway_runtime.js';

describe('resolveGatewayLaunch', () => {
  it('prefers the built gateway in production', () => {
    const result = resolveGatewayLaunch({
      cwd: '/repo',
      env: { NODE_ENV: 'production' },
      argv1: '/repo/dist/cli/index.js',
      exists: (path) => path === '/repo/dist/gateway/index.js',
    });

    expect(result).toEqual({
      command: process.execPath,
      args: ['/repo/dist/gateway/index.js'],
    });
  });

  it('uses the local tsx binary during source-driven development', () => {
    const result = resolveGatewayLaunch({
      cwd: '/repo',
      env: { NODE_ENV: 'development' },
      argv1: '/repo/src/cli/index.ts',
      exists: (path) => path === '/repo/node_modules/.bin/tsx',
    });

    expect(result).toEqual({
      command: '/repo/node_modules/.bin/tsx',
      args: ['/repo/src/gateway/index.ts'],
    });
  });

  it('falls back to the built gateway when tsx is unavailable', () => {
    const result = resolveGatewayLaunch({
      cwd: '/repo',
      env: {},
      argv1: '/repo/src/cli/index.ts',
      exists: (path) => path === '/repo/dist/gateway/index.js',
    });

    expect(result).toEqual({
      command: process.execPath,
      args: ['/repo/dist/gateway/index.js'],
    });
  });
});
