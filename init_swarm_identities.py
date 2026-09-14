import os
import sqlite3
import hashlib
import random
from google.oauth2 import service_account
from googleapiclient.discovery import build

SERVICE_ACCOUNT_FILE = os.path.expanduser('~/.config/antigravity-proxy/service-account.json')
SCOPES = ['https://www.googleapis.com/auth/admin.directory.user']
DB_PATH = os.path.expanduser('~/.omniroute/storage.sqlite')

DOMAINS = [
    {'domain': 'adamassist.com', 'admin': 'adam@adamassist.com'},
    {'domain': 'reseller.mysolidstate.ca', 'admin': 'apps@reseller.mysolidstate.ca'},
    {'domain': 'mysolidstate.ca', 'admin': 'adam@mysolidstate.ca'}
]

HUMAN_ACCOUNTS = [
    'adam@adamassist.com', 'apps@reseller.mysolidstate.ca', 'adam@mysolidstate.ca', 
    'kyle@mysolidstate.ca', 'chrisjeomara@gmail.com', 'falconeerkennels@gmail.com'
]

LOCATIONS = ['TX', 'NY', 'CA', 'UK', 'IN']
ROLES = ['COM', 'RES', 'SCR']
DEMOS = ['M', 'F', 'N']

def setup_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS swarm_identities (
            email TEXT PRIMARY KEY,
            tenant TEXT,
            is_human INTEGER,
            ssin TEXT,
            opaque_alias TEXT,
            cell_id TEXT,
            proxy_node TEXT
        )
    ''')
    conn.commit()
    return conn

def generate_opaque_alias(email, ssin):
    # Deterministic but opaque 8-character alias
    raw = f"{email}:{ssin}:solidstack_salt_2026"
    return hashlib.sha256(raw.encode()).hexdigest()[:8].upper()

def process_domains():
    conn = setup_db()
    c = conn.cursor()
    
    total_bots = 0
    
    for d in DOMAINS:
        print(f"\n--- Scanning Tenant: {d['domain']} ---")
        creds = service_account.Credentials.from_service_account_file(
            SERVICE_ACCOUNT_FILE, scopes=SCOPES
        ).with_subject(d['admin'])
        
        service = build('admin', 'directory_v1', credentials=creds)
        
        results = service.users().list(domain=d['domain'], maxResults=500).execute()
        users = results.get('users', [])
        
        for u in users:
            email = u['primaryEmail']
            is_human = 1 if email in HUMAN_ACCOUNTS else 0
            
            # Generate the true corporate identity (SSIN)
            loc = random.choice(LOCATIONS)
            role = 'OPR' if is_human else random.choice(ROLES)
            pod = '00' if is_human else f"{random.randint(1, 99):02d}"
            demo = 'M' if is_human else random.choice(DEMOS)
            seq = f"{random.randint(1, 9999):04d}"
            
            ssin = f"{loc}-{role}-{pod}-{demo}-{seq}X"
            alias = generate_opaque_alias(email, ssin)
            
            proxy_map = {
                'TX': 'dfw.socks.privado.io',
                'NY': 'ny.socks.privado.io',
                'CA': 'yul.socks.privado.io',
                'UK': 'lhr.socks.privado.io',
                'IN': 'bom.socks.privado.io'
            }
            proxy = 'DIRECT' if is_human else proxy_map.get(loc, 'DIRECT')
            
            c.execute('''
                INSERT OR IGNORE INTO swarm_identities 
                (email, tenant, is_human, ssin, opaque_alias, cell_id, proxy_node)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (email, d['domain'], is_human, ssin, alias, f"CELL-{loc}-{pod}", proxy))
            
            if not is_human:
                total_bots += 1

    conn.commit()
    conn.close()
    print(f"\nSuccessfully generated SSINs and Aliases for {total_bots} swarm agents across all 3 tenants.")
    print("Database `swarm_identities` is now populated.")
    print("READY FOR API INJECTION TO GOOGLE WORKSPACE.")

if __name__ == '__main__':
    process_domains()
