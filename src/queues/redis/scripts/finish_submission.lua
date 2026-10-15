-- KEYS[1]: transaction control hash. ARGV: owner task ID, outcome, reason code.
-- Old deliveries cannot clear a newer job's reservation.
-- This script never changes the transaction or its nonce.
if redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1] then return 0 end
local now = tonumber(redis.call('TIME')[1])
local failures = 0
if ARGV[2] ~= 'progress' then
    failures = tonumber(redis.call('HGET', KEYS[1], 'failures') or '0') + 1
end
redis.call('HDEL', KEYS[1], 'owner', 'ack_owner', 'ack_at')
redis.call('HSET', KEYS[1], 'failures', failures,
    'next_allowed', now + math.min(30 * 2 ^ math.max(failures - 1, 0), 900))
if ARGV[2] == 'permanent' or failures >= 8 then
    local reason = ARGV[2] == 'permanent' and ARGV[3] or 'retry_budget_exhausted'
    redis.call('HSET', KEYS[1], 'blocked', reason)
    redis.call('PERSIST', KEYS[1])
    return 2
else
    -- Completed/retryable controls expire after 30 idle days. Queued and
    -- operator-blocked controls have no time-based expiry.
    redis.call('EXPIRE', KEYS[1], 2592000)
end
return 1
