/**
 * @fileoverview Cron port — exposes the CronService to
 * route handlers via the shared route context.
 */

import type { CronService } from '../../cron/cron-service.js';

export interface CronPort {
  readonly cron: CronService;
}
