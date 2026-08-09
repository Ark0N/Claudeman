/**
 * @fileoverview Supervisor identity (systemd unit name / launchd job label).
 *
 * Three things now write or look for the same supervisor job: `install.sh`, the
 * in-app self-updater (`web/self-update.ts` detects it to decide how to restart),
 * and `codeman service install`. The names live here so they cannot drift apart,
 * because a mismatch is silent in the worst way: `service install` would happily
 * create a SECOND job alongside the installer's, and two servers sharing one data
 * dir and one tmux socket attach PTYs to each other's live sessions
 * (see config/instance.ts).
 *
 * The names are instance-scoped for exactly that reason: a `CODEMAN_INSTANCE=beta`
 * build writing `com.codeman.web` would overwrite the production LaunchAgent. The
 * DEFAULT instance keeps the historical names byte-identical, so existing installs
 * and every unit install.sh has already written are unaffected.
 *
 * @module config/service-names
 */

import { CODEMAN_INSTANCE } from './instance.js';

/**
 * Instance name reduced to characters that are safe in a filename and in a
 * launchd label. `CODEMAN_INSTANCE` is arbitrary operator input.
 */
const SAFE_INSTANCE = CODEMAN_INSTANCE.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);

/** systemd user unit: `codeman-web.service`, or `codeman-web-beta.service` for a beta. */
export const SYSTEMD_UNIT = `codeman-web${SAFE_INSTANCE ? `-${SAFE_INSTANCE}` : ''}.service`;

/** launchd job label: `com.codeman.web`, or `com.codeman.beta.web` for a beta. */
export const LAUNCHD_LABEL = SAFE_INSTANCE ? `com.codeman.${SAFE_INSTANCE}.web` : 'com.codeman.web';
