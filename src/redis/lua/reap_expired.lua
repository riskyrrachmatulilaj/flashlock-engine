-- reap_expired.lua
-- KEYS[1]: sale:{saleId}:state
-- KEYS[2]: sale:{saleId}:expiry_queue
-- KEYS[3]: sale:{saleId}:user_holds
--
-- ARGV[1]: now (epoch ms)
-- ARGV[2]: batch_size (default 100)

local sale_state_key = KEYS[1]
local expiry_queue_key = KEYS[2]
local user_holds_key = KEYS[3]

local now = tonumber(ARGV[1])
local batch_size = tonumber(ARGV[2] or 100)

local expired_ids = redis.call('ZRANGEBYSCORE', expiry_queue_key, '-inf', now, 'LIMIT', 0, batch_size)
local reaped_ids = {}

for _, res_id in ipairs(expired_ids) do
  local res_key = 'reservation:' .. res_id
  local status = redis.call('HGET', res_key, 'status')

  if status == 'HELD' or status == 'PAYMENT_PENDING' then
    local qty = tonumber(redis.call('HGET', res_key, 'quantity') or '0')
    local user_id = redis.call('HGET', res_key, 'user_id')

    redis.call('HSET', res_key, 'status', 'EXPIRED', 'updated_at', tostring(now))
    redis.call('HINCRBY', sale_state_key, 'held_stock', -qty)
    redis.call('HINCRBY', sale_state_key, 'available_stock', qty)

    if user_id and redis.call('HGET', user_holds_key, user_id) == res_id then
      redis.call('HDEL', user_holds_key, user_id)
    end

    table.insert(reaped_ids, res_id)
  end

  redis.call('ZREM', expiry_queue_key, res_id)
end

return reaped_ids
