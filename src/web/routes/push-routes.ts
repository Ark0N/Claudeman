/**
 * @fileoverview Push notification routes.
 * Manages VAPID keys, push subscriptions, and preference updates.
 */

import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { PushSubscribeSchema, PushPreferencesUpdateSchema } from '../schemas.js';
import { parseBody } from '../route-helpers.js';
import type { InfraPort } from '../ports/index.js';

export function registerPushRoutes(app: FastifyInstance, ctx: InfraPort): void {
  app.get('/api/push/vapid-key', async () => {
    return { success: true, data: { publicKey: ctx.pushStore.getPublicKey() } };
  });

  app.post('/api/push/subscribe', async (req) => {
    const { endpoint, keys, userAgent, pushPreferences } = parseBody(PushSubscribeSchema, req.body);
    const record = ctx.pushStore.addSubscription({
      id: uuidv4(),
      endpoint,
      keys,
      userAgent: userAgent ?? req.headers['user-agent'] ?? '',
      createdAt: Date.now(),
      pushPreferences: pushPreferences ?? {},
      // Multi-user: stamp the trusted caller identity so sendPushNotifications can
      // scope session notifications to the owner (+ admins). Undefined in single-user.
      username: req.authUser?.username,
      role: req.authUser?.role,
    });
    return { success: true, data: { id: record.id } };
  });

  app.put('/api/push/subscribe/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { pushPreferences } = parseBody(PushPreferencesUpdateSchema, req.body);
    const updated = ctx.pushStore.updatePreferences(id, pushPreferences);
    if (!updated) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Subscription not found');
    }
    return {};
  });

  app.delete('/api/push/subscribe/:id', async (req) => {
    const { id } = req.params as { id: string };
    const removed = ctx.pushStore.removeSubscription(id);
    if (!removed) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Subscription not found');
    }
    return {};
  });
}
