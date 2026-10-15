-- KEYS: status sorted set, job data hash, result hash, done set, dead set.
-- ARGV: age cutoff, batch size.
-- Preserve proof of a matching owner's terminal ACK before deleting its payload.
-- Both steps are atomic, so enqueue cannot lose the only evidence of completion.
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
if #ids == 0 then return 0 end

-- Redis script errors do not roll back writes. Preflight the entire batch.
local function check_type(key, expected)
    local kind = redis.call('TYPE', key).ok
    if kind ~= 'none' and kind ~= expected then
        error('Unexpected job cleanup key type')
    end
end
check_type(KEYS[2], 'hash')
check_type(KEYS[3], 'hash')
check_type(KEYS[4], 'zset')
check_type(KEYS[5], 'zset')
local evidence = {}
local keep_payload = {}
do
    for _, id in ipairs(ids) do
        local raw = redis.call('HGET', KEYS[2], id)
        if raw then
            local ok, request = pcall(cjson.decode, raw)
            local args = ok and type(request) == 'table' and request.args
            local job = type(args) == 'table' and args.data
            local metadata = type(job) == 'table' and job.metadata
            if type(metadata) == 'table' and metadata.redis_submission_owner == id
                and type(job.relayer_id) == 'string' and type(job.transaction_id) == 'string' then
                local control = KEYS[2] .. ':submission-control:' .. job.relayer_id .. ':' .. job.transaction_id
                check_type(control, 'hash')
                if redis.call('HGET', control, 'owner') == id then
                    local ended = redis.call('ZSCORE', KEYS[4], id)
                        or redis.call('ZSCORE', KEYS[5], id)
                    if ended then
                        table.insert(evidence, {control, id, ended})
                    else
                        -- An old retryable status is not proof that live work ended.
                        keep_payload[id] = true
                    end
                end
            end
        end
    end
end
for _, ack in ipairs(evidence) do
    redis.call('HSET', ack[1], 'ack_owner', ack[2], 'ack_at', ack[3])
end
for _, id in ipairs(ids) do
    redis.call('ZREM', KEYS[1], id)
    if not keep_payload[id] then
        redis.call('HDEL', KEYS[2], id)
        redis.call('HDEL', KEYS[3], id)
    end
end
return #ids
