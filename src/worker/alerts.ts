import { loadConfig, type ThufirConfig } from '../core/config.js';
import { createLlmClient } from '../core/llm.js';
import { createMarketClient } from '../execution/market-client.js';
import { PaperExecutor } from '../execution/modes/paper.js';
import { WebhookExecutor } from '../execution/modes/webhook.js';
import { UnsupportedLiveExecutor } from '../execution/modes/unsupported-live.js';
import { HyperliquidLiveExecutor } from '../execution/modes/hyperliquid-live.js';
import { DbSpendingLimitEnforcer } from '../execution/wallet/limits_db.js';
import { AutonomousManager } from '../core/autonomous.js';
import { Logger } from '../core/logger.js';
import type { ExecutionAdapter } from '../execution/executor.js';
import type { LlmClient } from '../core/llm.js';
import type { MarketClient } from '../execution/market-client.js';

export interface WorkerLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export interface WorkerAutonomousLifecycle {
  start(): void;
  stop(): void;
}

export interface WorkerProcessLike {
  pid: number;
  exit(code?: number): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

interface WorkerSignals {
  llm: LlmClient;
  marketClient: MarketClient;
  executor: ExecutionAdapter;
  limiter: DbSpendingLimitEnforcer;
}

export interface WorkerAlertsRuntime {
  config: ThufirConfig;
  logger: WorkerLogger;
  autonomous: WorkerAutonomousLifecycle;
  stop: () => Promise<void>;
}

export interface WorkerEntrypointRuntime {
  runtime: WorkerAlertsRuntime;
  removeShutdownHooks: () => void;
}

export interface WorkerAlertsDependencies {
  loadConfig?: (configPath?: string) => ThufirConfig;
  createLogger?: (level: string) => WorkerLogger;
  createLlmClient?: (config: ThufirConfig) => LlmClient;
  createMarketClient?: (config: ThufirConfig) => MarketClient;
  createLimiter?: (config: ThufirConfig) => DbSpendingLimitEnforcer;
  createExecutor?: (config: ThufirConfig) => Promise<ExecutionAdapter>;
  createAutonomousManager?: (
    config: ThufirConfig,
    signals: WorkerSignals,
    logger: WorkerLogger
  ) => WorkerAutonomousLifecycle;
  processRef?: WorkerProcessLike;
}

function resolveLogLevel(): string {
  const raw = String(process.env.THUFIR_LOG_LEVEL ?? 'info').toLowerCase();
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

async function defaultCreateExecutor(config: ThufirConfig): Promise<ExecutionAdapter> {
  if (config.execution.mode === 'live') {
    if (config.execution.provider === 'hyperliquid') {
      return new HyperliquidLiveExecutor({ config });
    }
    return new UnsupportedLiveExecutor();
  }

  if (config.execution.mode === 'webhook' && config.execution.webhookUrl) {
    return new WebhookExecutor(config.execution.webhookUrl);
  }

  return new PaperExecutor();
}

function removeProcessListener(
  processRef: WorkerProcessLike,
  event: string,
  listener: (...args: unknown[]) => void
): void {
  if (typeof processRef.off === 'function') {
    processRef.off(event, listener);
    return;
  }
  if (typeof processRef.removeListener === 'function') {
    processRef.removeListener(event, listener);
  }
}

export async function startWorkerAlertsService(options?: {
  configPath?: string;
  deps?: WorkerAlertsDependencies;
}): Promise<WorkerAlertsRuntime> {
  const deps = options?.deps ?? {};
  const config = (deps.loadConfig ?? loadConfig)(options?.configPath);
  const logger = (deps.createLogger ?? ((level) => new Logger(level as 'debug' | 'info' | 'warn' | 'error')))(
    resolveLogLevel()
  );

  if (config.memory?.dbPath) {
    process.env.THUFIR_DB_PATH = config.memory.dbPath;
  }

  if (!(config.autonomy?.enabled ?? false)) {
    throw new Error('Worker alerts service requires autonomy.enabled=true.');
  }

  const llm = (deps.createLlmClient ?? createLlmClient)(config);
  const marketClient = (deps.createMarketClient ?? createMarketClient)(config);
  const executor = await (deps.createExecutor ?? defaultCreateExecutor)(config);
  const limiter = (deps.createLimiter ??
    ((resolvedConfig) =>
      new DbSpendingLimitEnforcer({
        daily: resolvedConfig.wallet?.limits?.daily ?? 100,
        perTrade: resolvedConfig.wallet?.limits?.perTrade ?? 25,
        confirmationThreshold: resolvedConfig.wallet?.limits?.confirmationThreshold ?? 10,
      })))(config);

  const autonomous = (deps.createAutonomousManager ??
    ((resolvedConfig, signals, runtimeLogger) =>
      new AutonomousManager(
        signals.llm,
        signals.marketClient,
        signals.executor,
        signals.limiter,
        resolvedConfig,
        runtimeLogger as Logger
      )))(
    config,
    { llm, marketClient, executor, limiter },
    logger
  );

  autonomous.start();

  const processRef = deps.processRef ?? (process as unknown as WorkerProcessLike);
  logger.info('Worker alerts service started', {
    pid: processRef.pid,
    scanIntervalSeconds: config.autonomy?.scanIntervalSeconds ?? 900,
  });

  let stopped = false;
  return {
    config,
    logger,
    autonomous,
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      autonomous.stop();
      logger.info('Worker alerts service stopped');
    },
  };
}

export function installWorkerShutdownHooks(input: {
  logger: WorkerLogger;
  stop: () => Promise<void>;
  processRef?: WorkerProcessLike;
}): () => void {
  const processRef = input.processRef ?? (process as unknown as WorkerProcessLike);
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode: number, meta?: unknown): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (meta !== undefined) {
      input.logger.error(`Worker alerts service exiting (${reason})`, meta);
    } else {
      input.logger.info(`Worker alerts service exiting (${reason})`);
    }

    try {
      await input.stop();
    } catch (error) {
      input.logger.error('Worker alerts service failed during shutdown', error);
      processRef.exit(1);
      return;
    }

    processRef.exit(exitCode);
  };

  const onSigInt = () => {
    void shutdown('SIGINT', 0);
  };
  const onSigTerm = () => {
    void shutdown('SIGTERM', 0);
  };
  const onUnhandledRejection = (reason: unknown) => {
    void shutdown('unhandledRejection', 1, reason);
  };
  const onUncaughtException = (error: unknown) => {
    void shutdown('uncaughtException', 1, error);
  };

  processRef.on('SIGINT', onSigInt);
  processRef.on('SIGTERM', onSigTerm);
  processRef.on('unhandledRejection', onUnhandledRejection);
  processRef.on('uncaughtException', onUncaughtException);

  return () => {
    removeProcessListener(processRef, 'SIGINT', onSigInt);
    removeProcessListener(processRef, 'SIGTERM', onSigTerm);
    removeProcessListener(processRef, 'unhandledRejection', onUnhandledRejection);
    removeProcessListener(processRef, 'uncaughtException', onUncaughtException);
  };
}

export async function runWorkerAlertsEntrypoint(options?: {
  configPath?: string;
  deps?: WorkerAlertsDependencies;
}): Promise<WorkerEntrypointRuntime> {
  const runtime = await startWorkerAlertsService(options);
  const removeShutdownHooks = installWorkerShutdownHooks({
    logger: runtime.logger,
    stop: runtime.stop,
    processRef: options?.deps?.processRef,
  });

  return { runtime, removeShutdownHooks };
}
