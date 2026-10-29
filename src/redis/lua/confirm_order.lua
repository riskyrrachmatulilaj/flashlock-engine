-- confirm_order.lua
-- KEYS[1]: sale:{saleId}:state
-- KEYS[2]: sale:{saleId}:expiry_queue
-- KEYS[3]: sale:{saleId}:user_holds
-- KEYS[4]: sale:{saleId}:user_purchases
-- KEYS[5]: reservation:{resId}
--
-- ARGV[1]: resId
-- ARGV[2]: outcome ("succeeded" or "failed")
-- ARGV[3]: now (epoch ms)

local sale_state_key = KEYS[1]
local expiry_queue_key = KEYS[2]
local user_holds_key = KEYS[3]
local user_purchases_key = KEYS[4]
local reservation_key = KEYS[5]

local res_id = ARGV[1]
local outcome = ARGV[2]
local now = tonumber(ARGV[3])

local status = redis.call('HGET', reservation_key, 'status')
if not status then
  return { 'ERR_RESERVATION_NOT_FOUND' }
end

local qty = tonumber(redis.call('HGET', reservation_key, 'quantity') or '0')
local user_id = redis.call('HGET', reservation_key, 'user_id')

if outcome == 'succeeded' then
  if status == 'CONFIRMED' then
    return { 'OK_ALREADY_CONFIRMED', tostring(qty), user_id or '' }
  elseif status == 'HELD' or status == 'PAYMENT_PENDING' then
    redis.call('HSET', reservation_key, 'status', 'CONFIRMED', 'updated_at', tostring(now))
    redis.call('HINCRBY', sale_state_key, 'held_stock', -qty)
    redis.call('HINCRBY', sale_state_key, 'sold_stock', qty)
    redis.call('ZREM', expiry_queue_key, res_id)
    if user_id then
      redis.call('HDEL', user_holds_key, user_id)
      redis.call('HSET', user_purchases_key, user_id, res_id)
    end
    return { 'OK_CONFIRMED', tostring(qty), user_id or '' }
  elseif status == 'EXPIRED' then
    -- Late webhook: stock was already reaped and returned to available_stock.
    -- Invariant preserved: DO NOT touch stock counters!
    return { 'LATE_PAYMENT_DETECTED', tostring(qty), user_id or '' }
  else
    return { 'ERR_INVALID_STATUS', status }
  end
elseif outcome == 'failed' then
  if status == 'HELD' or status == 'PAYMENT_PENDING' then
    redis.call('HSET', reservation_key, 'status', 'EXPIRED', 'updated_at', tostring(now))
    redis.call('HINCRBY', sale_state_key, 'held_stock', -qty)
    redis.call('HINCRBY', sale_state_key, 'available_stock', qty)
    redis.call('ZREM', expiry_queue_key, res_id)
    if user_id and redis.call('HGET', user_holds_key, user_id) == res_id then
      redis.call('HDEL', user_holds_key, user_id)
    end
    return { 'OK_EXPIRED_ON_FAILURE', tostring(qty), user_id or '' }
  elseif status == 'EXPIRED' then
    return { 'OK_ALREADY_EXPIRED', tostring(qty), user_id or '' }
  else
    return { 'ERR_INVALID_STATUS', status }
  end
else
  return { 'ERR_INVALID_OUTCOME', outcome }
end
