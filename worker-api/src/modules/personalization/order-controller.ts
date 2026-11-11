/**
 * Merchant Orders routes. Authenticated and always scoped to the token's store (the tenant middleware
 * runs before these); a client-supplied store id is never read. Order details may contain customer
 * PII, so responses are never cacheable.
 */

import type { Context } from 'hono';
import type { AppEnv } from '../../shared/context';
import { ok } from '../../shared/responses';
import { OrderService } from './order-service';
import { orderIdParamSchema, orderListQuerySchema } from './validation';

function noStore(res: Response): Response {
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
}

export async function listOrders(c: Context<AppEnv>): Promise<Response> {
  const query = orderListQuerySchema.parse(c.req.query());
  const { items, page } = await new OrderService(c.get('db')).list(c.get('tenant').storeId, query);
  return noStore(ok(c, items, 200, { pagination: page }));
}

export async function getOrder(c: Context<AppEnv>): Promise<Response> {
  const orderId = orderIdParamSchema.parse(c.req.param('orderId'));
  return noStore(ok(c, await new OrderService(c.get('db')).get(c.get('tenant').storeId, orderId)));
}
