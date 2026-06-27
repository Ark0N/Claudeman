/**
 * @fileoverview Scheduler port — exposes the cron-style SchedulerService to
 * route handlers via the shared route context.
 */

import type { SchedulerService } from '../../scheduler/scheduler-service.js';

export interface SchedulerPort {
  readonly scheduler: SchedulerService;
}
