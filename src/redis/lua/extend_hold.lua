-- extend_hold.lua
-- KEYS[1]: sale:{saleId}:expiry_queue
-- KEYS[2]: reservation:{resId}
--
-- ARGV[1]: resId
-- ARGV[2]: userId
-- ARGV[3]: now (epoch ms)
-- ARGV[4]: extension_ms (e.g. 60000)

local expiry_queue_key = KEYS[1]
local reservation_key = KEYS[2]

local res_id = ARGV[1]
local user_id = ARGV[2]
local now = tonumber(ARGV[3])
local extension_ms = tonumber(ARGV[4])

local status = redis.call('HGET', reservation_key, 'status')
if not status then
  return { 'ERR_RESERVATION_NOT_FOUND' }
end

local owner = redis.call('HGET', reservation_key, 'user_id')
if owner ~= user_id then
  return { 'ERR_UNAUTHORIZED' }
end

local expires_at = tonumber(redis.call('HGET', reservation_key, 'expires_at') or '0')
if now >= expires_at or status == 'EXPIRED' then
  return { 'ERR_RESERVATION_EXPIRED' }
end

if status ~= 'HELD' and status ~= 'PAYMENT_PENDING' then
  return { 'ERR_INVALID_STATUS', status }
end

local new_expires_at = expires_at + extension_ms

redis.call(
  'HSET',
  reservation_key,
  'status', 'PAYMENT_PENDING',
  'expires_at', tostring(new_expires_at),
  'updated_at', tostring(now)
)

redis.call('ZADD', expiry_queue_key, new_expires_at, res_id)

return { 'OK_EXTENDED', tostring(new_expires_at) }
