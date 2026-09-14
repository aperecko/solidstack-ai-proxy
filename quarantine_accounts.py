import json
import os
import shutil

path = os.path.expanduser('~/.config/antigravity-proxy/accounts.json')
backup_path = path + '.bak.quarantine'

# Backup first
shutil.copy(path, backup_path)

with open(path, 'r') as f:
    data = json.load(f)

is_dict = isinstance(data, dict)
accounts = data.get('accounts', []) if is_dict else data

# Filter out the adamassist.com swarm accounts
valid_accounts = [a for a in accounts if not a.get('email', '').endswith('@adamassist.com')]

removed_count = len(accounts) - len(valid_accounts)

if is_dict:
    data['accounts'] = valid_accounts
else:
    data = valid_accounts

with open(path, 'w') as f:
    json.dump(data, f, indent=2)

print(f"Quarantine successful. {removed_count} @adamassist.com accounts have been purged from the active proxy rotation.")
