import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
it('publishes all marketing and health routes with strict input contracts', async () => {
  const contract = parse(await readFile('docs/openapi.yaml', 'utf8'));
  expect(contract.openapi).toBe('3.1.0');
  expect(Object.keys(contract.paths)).toHaveLength(11);
  for (const name of [
    'Feedback',
    'Subscribe',
    'Token',
    'Preferences',
    'PreferenceRequest',
    'Contact',
    'Business',
    'Webhook',
  ])
    expect(contract.components.schemas[name].additionalProperties).toBe(false);
  expect(
    contract.paths['/api/v1/marketing/subscriptions/preferences'].get.security,
  ).toEqual([{ PreferencesBearer: [] }]);
  expect(
    contract.paths['/api/v1/marketing/subscriptions/unsubscribe'].get,
  ).toBeUndefined();
});
