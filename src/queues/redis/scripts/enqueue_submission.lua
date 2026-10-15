-- Apalis 0.7.4-compatible atomic enqueue with one reservation per transaction.
-- KEYS: data, active, signal, scheduled, control, done, dead.
-- ARGV: new task ID, serialized Request, scheduled epoch (empty for immediate).
-- Queued reservations do not expire: Apalis recovers orphaned workers using
-- the same task ID, without permitting a second job to race the first.
local now = tonumber(redis.call('TIME')[1])
local owner = redis.call('HGET', KEYS[5], 'owner')
if owner then
    local ended = redis.call('ZSCORE', KEYS[6], owner)
        or redis.call('ZSCORE', KEYS[7], owner)
    -- System cleanup copies terminal ACK evidence before aging out Apalis sets.
    -- Only evidence for this exact owner can release a persistent reservation.
    if not ended and redis.call('HGET', KEYS[5], 'ack_owner') == owner then
        ended = redis.call('HGET', KEYS[5], 'ack_at')
    end
    if not ended then return {0, owner, 'queued_or_running'} end
    -- Recover a lost completion update from Apalis's durable acknowledgement.
    -- Count its unknown outcome conservatively as a failed attempt.
    local failures = redis.call('HINCRBY', KEYS[5], 'failures', 1)
    redis.call('HDEL', KEYS[5], 'owner', 'ack_owner', 'ack_at')
    redis.call('HSET', KEYS[5], 'next_allowed',
        tonumber(ended) + math.min(30 * 2 ^ (failures - 1), 900))
    if failures >= 8 then
        redis.call('HSET', KEYS[5], 'blocked', 'retry_budget_exhausted')
    else
        redis.call('EXPIRE', KEYS[5], 2592000)
    end
end
local blocked = redis.call('HGET', KEYS[5], 'blocked')
if blocked then return {-1, '', blocked} end
if tonumber(redis.call('HGET', KEYS[5], 'next_allowed') or '0') > now then
    return {0, '', 'cooldown'}
end
-- Lua runtime errors do not roll back writes. Validate queue types first.
local function check_type(key, expected)
    local kind = redis.call('TYPE', key).ok
    if kind ~= 'none' and kind ~= expected then
        error('Unexpected submission queue key type')
    end
end
check_type(KEYS[1], 'hash')
check_type(KEYS[2], 'list')
check_type(KEYS[3], 'list')
check_type(KEYS[4], 'zset')
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
    return redis.error_reply('Submission task ID already exists')
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
if ARGV[3] ~= '' then
    redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1])
else
    redis.call('RPUSH', KEYS[2], ARGV[1])
    redis.call('DEL', KEYS[3])
    redis.call('LPUSH', KEYS[3], 1)
end
redis.call('HDEL', KEYS[5], 'ack_owner', 'ack_at')
redis.call('HSET', KEYS[5], 'owner', ARGV[1])
redis.call('PERSIST', KEYS[5])
return {1, ARGV[1], 'enqueued'}
