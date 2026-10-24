/**
 * The deployment's own settings, for a platform admin.
 *
 * GET says what is set and where each value comes from; PUT sets one; DELETE
 * clears one so the environment's value, if any, is in force again. No
 * secret is ever returned: a hint is the most that comes back. Refused for
 * anyone whose address is not on the operator's list, whatever their role in
 * any workspace.
 */
import { z } from 'zod';
import { PlatformSettingsRepository } from '@salvations/db';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { userRoute } from '@/lib/route';
import { db } from '@/lib/db';
import { keyProvider } from '@/lib/keys';
import {
  PLATFORM_SETTINGS, SETTING_GROUPS, describePlatformSettings, invalidatePlatformSettings, isPlatformAdmin, settingSpec,
} from '@/lib/platform-settings';

export const runtime = 'nodejs';

const putSchema = z.object({
  key: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(4000),
});

const forbidden = () => errorResponse(403, 'forbidden', 'Only a platform admin may change the deployment\'s settings.');

async function describe(database: Awaited<ReturnType<typeof db>>['db']): Promise<Response> {
  const items = await describePlatformSettings(database);
  const groups = (Object.keys(SETTING_GROUPS) as (keyof typeof SETTING_GROUPS)[])
    .map((id) => ({ id, ...SETTING_GROUPS[id] }));
  return ok({ groups, items, keys: PLATFORM_SETTINGS.map((s) => s.key) });
}

export const GET = userRoute(async (_request, userId) => {
  const handle = await db();
  if (!await isPlatformAdmin(handle.db, userId)) return forbidden();
  return describe(handle.db);
});

export const PUT = userRoute(async (request, userId) => {
  const handle = await db();
  if (!await isPlatformAdmin(handle.db, userId)) return forbidden();
  const input = await jsonBody(request, putSchema);
  const spec = settingSpec(input.key);
  if (spec === undefined) return errorResponse(404, 'not_found', `There is no setting called "${input.key}".`);
  if (spec.key === 'platform_ai_monthly_usd_cap' && !(Number(input.value) > 0)) {
    return errorResponse(422, 'validation_failed', 'The allowance is a positive number of dollars.');
  }
  if (spec.key === 'meta_whatsapp_verify_token' && input.value.length < 8) {
    return errorResponse(422, 'validation_failed', 'The verify token needs eight characters or more.');
  }
  await new PlatformSettingsRepository(handle.db, keyProvider()).set(spec.key, input.value, { secret: spec.secret, updatedBy: userId });
  invalidatePlatformSettings();
  // Who changed what, never the value.
  console.log(JSON.stringify({ at: 'platform-settings', set: spec.key, by: userId }));
  return describe(handle.db);
});

export const DELETE = userRoute(async (request, userId) => {
  const handle = await db();
  if (!await isPlatformAdmin(handle.db, userId)) return forbidden();
  const key = new URL(request.url).searchParams.get('key') ?? '';
  const spec = settingSpec(key);
  if (spec === undefined) return errorResponse(404, 'not_found', `There is no setting called "${key}".`);
  await new PlatformSettingsRepository(handle.db, keyProvider()).clear(spec.key);
  invalidatePlatformSettings();
  console.log(JSON.stringify({ at: 'platform-settings', cleared: spec.key, by: userId }));
  return describe(handle.db);
});
