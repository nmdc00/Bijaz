import type { Logger } from '../core/logger.js';
import type { ThufirConfig } from '../core/config.js';
import type { ToolExecutorContext } from '../core/tool-executor.js';

import { TradeMonitor } from './monitor.js';

export class TradeManagementService {
  private monitor: TradeMonitor | null = null;

  constructor(
    private config: ThufirConfig,
    private toolContext: ToolExecutorContext,
    private logger: Logger
  ) {}

  start(): void {
    if (!this.config.tradeManagement?.enabled) {
      return;
    }
    if (this.monitor) return;
    this.logger.info('TradeManagement: started');
    this.monitor = new TradeMonitor(this.config, this.toolContext, this.logger);
    this.monitor.start();
  }

  stop(): void {
    if (!this.monitor) return;
    this.logger.info('TradeManagement: stopped');
    this.monitor.stop();
    this.monitor = null;
  }
}

