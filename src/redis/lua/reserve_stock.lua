-- reserve_stock.lua
-- KEYS[1]: sale:{saleId}:state
-- KEYS[2]: sale:{saleId}:user_holds
-- KEYS[3]: sale:{saleId}:expiry_queue
-- KEYS[4]: reservation:{resId}
-- KEYS[5]: sale:{saleId}:user_purchases
-- KEYS[6]: idempotency:{idempotencyKey}
--
-- ARGV[1]: resId
-- ARGV[2]: userId
-- ARGV[3]: qty (1 or 2)
-- ARGV[4]: now (epoch ms)
-- ARGV[5]: ttl_ms (e.g. 300000)
-- ARGV[6]: saleId
-- ARGV[7]: idempotencyKey

local sale_state_key = KEYS[1]
local user_holds_key = KEYS[2]
local expiry_queue_key = KEYS[3]
local reservation_key = KEYS[4]
local user_purchases_key = KEYS[5]
local idempotency_key = KEYS[6]

local res_id = ARGV[1]
local user_id = ARGV[2]
local req_qty = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local ttl_ms = tonumber(ARGV[5])
local sale_id = ARGV[6]
local raw_idempotency_key = ARGV[7]

-- 1. Check sale exists
local exists = redis.call('EXISTS', sale_state_key)
if exists == 0 then
  return { 'ERR_SALE_NOT_FOUND' }
end

-- 2. Check sale start time
local start_time = tonumber(redis.call('HGET', sale_state_key, 'start_time') or '0')
if now < start_time then
  return { 'ERR_SALE_NOT_STARTED' }
end

-- 3. Check if user already completed purchase for this sale
if redis.call('HEXISTS', user_purchases_key, user_id) == 1 then
  return { 'ERR_USER_ALREADY_PURCHASED' }
end

-- 4. Check idempotency key
local idemp_res_id = redis.call('GET', idempotency_key)
if idemp_res_id then
  local idemp_key = 'reservation:' .. idemp_res_id
  local status = redis.call('HGET', idemp_key, 'status')
  local qty = redis.call('HGET', idemp_key, 'quantity')
  local exp = redis.call('HGET', idemp_key, 'expires_at')
  return { 'OK_EXISTING', idemp_res_id, status or '', qty or '', exp or '' }
end

-- 5. Check if user already has an active hold
local existing_user_res_id = redis.call('HGET', user_holds_key, user_id)
if existing_user_res_id then
  local existing_key = 'reservation:' .. existing_user_res_id
  local status = redis.call('HGET', existing_key, 'status')
  if status == 'HELD' or status == 'PAYMENT_PENDING' then
    local qty = redis.call('HGET', existing_key, 'quantity')
    local exp = redis.call('HGET', existing_key, 'expires_at')
    return { 'OK_EXISTING', existing_user_res_id, status, qty or '', exp or '' }
  else
    redis.call('HDEL', user_holds_key, user_id)
  end
end

-- 6. Check stock availability
local available_stock = tonumber(redis.call('HGET', sale_state_key, 'available_stock') or '0')
local held_stock = tonumber(redis.call('HGET', sale_state_key, 'held_stock') or '0')

if available_stock < req_qty then
  if available_stock == 0 and held_stock == 0 then
    return { 'ERR_SOLD_OUT' }
  else
    return { 'ERR_INSUFFICIENT_STOCK' }
  end
end

-- 7. Reserve atomically
redis.call('HINCRBY', sale_state_key, 'available_stock', -req_qty)
redis.call('HINCRBY', sale_state_key, 'held_stock', req_qty)

local expires_at = now + ttl_ms

redis.call(
  'HSET',
  reservation_key,
  'id', res_id,
  'sale_id', sale_id,
  'user_id', user_id,
  'quantity', tostring(req_qty),
  'status', 'HELD',
  'idempotency_key', raw_idempotency_key,
  'created_at', tostring(now),
  'expires_at', tostring(expires_at)
)

redis.call('HSET', user_holds_key, user_id, res_id)
redis.call('ZADD', expiry_queue_key, expires_at, res_id)
redis.call('SET', idempotency_key, res_id, 'PX', ttl_ms + 600000)

return { 'OK_CREATED', res_id, tostring(expires_at) }
