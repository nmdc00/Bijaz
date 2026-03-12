import { beforeEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.hoisted(() => vi.fn());
const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');

vi.mock('node:child_process', () => ({
  exec: execMock,
  spawn: vi.fn(),
}));

describe('tool-executor qmd integration', () => {
  let commands: string[] = [];

  beforeEach(() => {
    execMock.mockReset();
    vi.resetModules();
    commands = [];
  });

  const ctx = {
    config: {
      qmd: {
        enabled: true,
      },
    },
    marketClient: {},
  } as any;

  function mockExecImplementation(
    impl: (command: string) => { stdout?: string; stderr?: string; error?: Error }
  ) {
    execMock[promisifyCustom as keyof typeof execMock] = (command: string) => {
      commands.push(command);
      const result = impl(command);
      if (result.error) {
        return Promise.reject(result.error);
      }
      return Promise.resolve({
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      });
    };
    execMock.mockImplementation((command: string, options: unknown, callback?: unknown) => {
      commands.push(command);
      const cb = typeof options === 'function' ? options : callback;
      const result = impl(command);
      queueMicrotask(() => {
        (cb as (error: Error | null, stdout: string, stderr: string) => void)(
          result.error ?? null,
          result.stdout ?? '',
          result.stderr ?? ''
        );
      });
      return {} as any;
    });
  }

  it('uses the current qmd json and limit flags', async () => {
    mockExecImplementation((command) => {
      if (command === 'qmd --version') {
        return { stdout: 'qmd 1.0.0\n' };
      }
      if (command.includes('search "fragility" --json -n 3 -c thufir-intel')) {
        return { stdout: '[]' };
      }
      return { error: new Error(`unexpected command: ${command}`) };
    });

    const { executeToolCall } = await import('../../src/core/tool-executor.js');
    const result = await executeToolCall(
      'qmd_query',
      { query: 'fragility', mode: 'search', limit: 3, collection: 'thufir-intel' },
      ctx
    );

    expect(result.success).toBe(true);
    expect(commands).toContain('"qmd" search "fragility" --json -n 3 -c thufir-intel');
  });

  it('falls back to keyword search when deep query crashes', async () => {
    mockExecImplementation((command) => {
      if (command === 'qmd --version') {
        return { stdout: 'qmd 1.0.0\n' };
      }
      if (command.includes('query "fragility" --json -n 5 -c thufir-intel')) {
        return {
          error: new Error(
            'Command failed: qmd query "fragility" --json -n 5 -c thufir-intel\npanic: Segmentation fault'
          ),
        };
      }
      if (command.includes('search "fragility" --json -n 5 -c thufir-intel')) {
        return { stdout: '[{"file":"note.md","score":1}]' };
      }
      return { error: new Error(`unexpected command: ${command}`) };
    });

    const { executeToolCall } = await import('../../src/core/tool-executor.js');
    const result = await executeToolCall(
      'qmd_query',
      { query: 'fragility', mode: 'query', limit: 5, collection: 'thufir-intel' },
      ctx
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        mode: 'search',
        requestedMode: 'query',
        degraded: true,
      });
    }
  });
});
