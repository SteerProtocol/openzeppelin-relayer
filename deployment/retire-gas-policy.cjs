'use strict';
const { isDeepStrictEqual } = require('node:util');
function stripRetiredPolicy(serialized) {
  const original = JSON.parse(serialized);
  if (!original.policies || !Object.hasOwn(original.policies, 'gas_limit_buffer_percent')) return serialized;
  const expected = JSON.parse(serialized);
  delete expected.policies.gas_limit_buffer_percent;
  let cleaned = serialized.replace(/,\s*"gas_limit_buffer_percent"\s*:\s*(?:null|\d+)/, '');
  if (cleaned === serialized) cleaned = serialized.replace(/"gas_limit_buffer_percent"\s*:\s*(?:null|\d+)\s*,?\s*/, '');
  if (!isDeepStrictEqual(JSON.parse(cleaned), expected)) throw new Error('Retired policy removal changed another field');
  return cleaned;
}
async function retirePolicies(redis, ids, prefix = 'oz-relayer') {
  let changed = 0;
  for (const id of ids) {
    if (!/^[a-z0-9]+-node-[123]$/.test(id)) throw new Error('Invalid migration relayer');
    const key = `${prefix}:relayer:${id}`;
    const stored = await redis.get(key);
    if (!stored) continue;
    const cleaned = stripRetiredPolicy(stored);
    if (cleaned === stored) continue;
    const updated = await redis.eval("if redis.call('GET',KEYS[1]) == ARGV[1] then redis.call('SET',KEYS[1],ARGV[2],'KEEPTTL');return 1 else return 0 end", 1, key, stored, cleaned);
    if (updated !== 1) throw new Error('Concurrent policy modification; migration stopped');
    changed++;
  }
  return changed;
}
module.exports = { stripRetiredPolicy, retirePolicies };
