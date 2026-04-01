import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type GatewayLaunchSpec = {
  command: string;
  args: string[];
};

type ResolveGatewayLaunchParams = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  argv1?: string;
  exists?: (path: string) => boolean;
};

export function resolveGatewayLaunch(params: ResolveGatewayLaunchParams = {}): GatewayLaunchSpec {
  const cwd = params.cwd ?? process.cwd();
  const env = params.env ?? process.env;
  const argv1 = params.argv1 ?? process.argv[1] ?? '';
  const exists = params.exists ?? existsSync;

  const builtGatewayPath = resolve(cwd, 'dist', 'gateway', 'index.js');
  const sourceGatewayPath = resolve(cwd, 'src', 'gateway', 'index.ts');
  const localTsxPath = resolve(cwd, 'node_modules', '.bin', 'tsx');
  const runningBuiltCli = /(^|[\\/])dist[\\/]cli([\\/]|$)/.test(argv1);
  const preferBuiltGateway = env.NODE_ENV === 'production' || runningBuiltCli;

  if (preferBuiltGateway && exists(builtGatewayPath)) {
    return {
      command: process.execPath,
      args: [builtGatewayPath],
    };
  }

  if (exists(localTsxPath)) {
    return {
      command: localTsxPath,
      args: [sourceGatewayPath],
    };
  }

  if (exists(builtGatewayPath)) {
    return {
      command: process.execPath,
      args: [builtGatewayPath],
    };
  }

  return {
    command: 'tsx',
    args: ['src/gateway/index.ts'],
  };
}
