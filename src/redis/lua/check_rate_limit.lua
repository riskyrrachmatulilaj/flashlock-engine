-- check_rate_limit.lua
-- KEYS[1]: ratelimit:{userId}
-- ARGV[1]: now (epoch ms)
-- ARGV[2]: window_ms (e.g. 10000)
-- ARGV[3]: limit (e.g. 5)
-- ARGV[4]: member (e.g. "now:uuid")

local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local member = ARGV[4]

local clear_before = now - window
redis.call('ZREMRANGEBYSCORE', key, '-inf', clear_before)
local current = redis.call('ZCARD', key)

if current < max_requests then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return 1
else
  return 0
end
