/** @fileoverview Authenticated owner-scoped tab-layout read/write API. */
import type { FastifyInstance } from 'fastify';
import { ownerLayoutKey } from '../../tab-layout-persistence.js';
import { TabLayoutValidationError } from '../../tab-layout.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { ownerFor } from '../route-helpers.js';
import type { TabLayoutPort } from '../ports/index.js';

export const TAB_LAYOUT_BODY_LIMIT = 128 * 1024;

function parseWriteBody(body: unknown): { baseVersion: number; layout: unknown } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new TabLayoutValidationError('body must be an object');
  }
  const keys = Object.keys(body);
  if (keys.length !== 2 || !Object.hasOwn(body, 'baseVersion') || !Object.hasOwn(body, 'layout')) {
    throw new TabLayoutValidationError('body must contain exactly baseVersion and layout');
  }
  const input = body as { baseVersion?: unknown; layout?: unknown };
  if (!Number.isSafeInteger(input.baseVersion) || (input.baseVersion as number) < 0 || input.layout === undefined) {
    throw new TabLayoutValidationError('baseVersion must be a non-negative safe integer and layout is required');
  }
  return { baseVersion: input.baseVersion as number, layout: input.layout };
}

export function registerTabLayoutRoutes(app: FastifyInstance, ctx: TabLayoutPort): void {
  app.get('/api/tab-layout', async (req) => ({
    success: true,
    data: { layout: await ctx.tabLayouts.get(ownerLayoutKey(ownerFor(req))) },
  }));

  app.put('/api/tab-layout', { bodyLimit: TAB_LAYOUT_BODY_LIMIT }, async (req, reply) => {
    try {
      const { baseVersion, layout } = parseWriteBody(req.body);
      const result = await ctx.tabLayouts.put(ownerLayoutKey(ownerFor(req)), layout, baseVersion);
      if (result.status === 'conflict') {
        return reply.code(409).send({
          ...createErrorResponse(ApiErrorCode.CONFLICT, 'Tab layout version conflict'),
          data: { layout: result.layout },
        });
      }
      return { success: true, data: { layout: result.layout } };
    } catch (error) {
      if (error instanceof TabLayoutValidationError) {
        return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, error.message));
      }
      throw error;
    }
  });
}
