import json

config_path = "/Users/test/.config/antigravity-proxy/config.json"

with open(config_path, "r") as f:
    config = json.load(f)

# Uncap the active pool to support the full 345 node swarm
if "maxAccounts" in config:
    config["maxAccounts"] = 365

# Ensure AI proxy relies on OmniRoute for failover rather than micromanaging it
# by relaxing the extended cooldown and max failures at this layer.
if "maxConsecutiveFailures" in config:
    config["maxConsecutiveFailures"] = 5  # Give OmniRoute time to handle it natively

with open(config_path, "w") as f:
    json.dump(config, f, indent=2)

print("Proxy config updated.")
