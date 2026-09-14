import os
from google.oauth2 import service_account
from googleapiclient.discovery import build

SERVICE_ACCOUNT_FILE = os.path.expanduser('~/.config/antigravity-proxy/service-account.json')
SCOPES = ['https://www.googleapis.com/auth/admin.directory.user']

def check_all_accounts():
    creds = service_account.Credentials.from_service_account_file(
        SERVICE_ACCOUNT_FILE, scopes=SCOPES
    ).with_subject('adam@adamassist.com')

    service = build('admin', 'directory_v1', credentials=creds)

    print("Checking adamassist.com accounts...")
    
    results = service.users().list(domain='adamassist.com', maxResults=500).execute()
    users = results.get('users', [])
    
    healthy = []
    suspended = []
    
    for u in users:
        email = u['primaryEmail']
        if u.get('suspended'):
            reason = u.get('suspensionReason', 'Unknown')
            suspended.append((email, reason))
        else:
            healthy.append(email)
            
    print(f"\n--- TOTAL ACCOUNTS: {len(users)} ---")
    print(f"✅ HEALTHY: {len(healthy)}")
    print(f"❌ SUSPENDED: {len(suspended)}")
    
    print("\nSuspended Breakdown:")
    for email, reason in suspended:
        print(f"  - {email}: {reason}")
        
    print("\nHealthy Examples (first 10):")
    for email in sorted(healthy)[:10]:
        print(f"  - {email}")

if __name__ == '__main__':
    check_all_accounts()
