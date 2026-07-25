/**
 * @fileoverview Process-level Codeman instance controls exposed to system routes.
 */

export type InstanceShutdownStrategy = 'manual' | 'systemd-user' | 'systemd-system' | 'launchd-user' | 'launchd-system';

export type InstanceShutdownResult =
  | {
      accepted: true;
      strategy: InstanceShutdownStrategy;
      alreadyScheduled: boolean;
    }
  | {
      accepted: false;
      reason: string;
    };

export interface InstanceControlPort {
  requestInstanceShutdown(): Promise<InstanceShutdownResult>;
}
