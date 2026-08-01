wrk.method = "POST"
wrk.path = "/abc"
wrk.headers["Content-Type"] = "application/json"

local kb = 1024
local pad = string.rep("x", 4 * kb)
wrk.body = '{"n":1,"pad":"' .. pad .. '"}'
