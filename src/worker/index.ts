#!/usr/bin/env node
import 'dotenv/config';

import { runWorkerAlertsEntrypoint } from './alerts.js';

runWorkerAlertsEntrypoint().catch((error) => {
  console.error('Failed to start worker alerts service', error);
  process.exit(1);
});
