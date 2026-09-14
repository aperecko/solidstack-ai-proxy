import json
import hashlib
import random
import os

# Set absolute path for the artifact directory
ARTIFACT_DIR = "/Users/test/.gemini/antigravity/brain/7ace170d-ea22-45d4-9f07-1b978e33ffec"
os.makedirs(ARTIFACT_DIR, exist_ok=True)

# Deterministic seed so the organization remains stable if re-run
random.seed(4242)

# Source Data
adamassist_accounts = ["adam@adamassist.com"] + [f"{str(i).zfill(2)}@adamassist.com" for i in range(1, 49)]
reseller_accounts = [f"{str(i).zfill(6)}@reseller.mysolidstate.ca" for i in range(1, 297)]

first_names = ["James", "Mary", "Robert", "Patricia", "John", "Jennifer", "Michael", "Linda", "David", "Elizabeth", "William", "Barbara", "Richard", "Susan", "Joseph", "Jessica", "Thomas", "Sarah", "Charles", "Karen", "Christopher", "Lisa", "Daniel", "Nancy", "Matthew", "Betty", "Anthony", "Margaret", "Mark", "Sandra", "Donald", "Ashley", "Steven", "Kimberly", "Paul", "Emily", "Andrew", "Donna", "Joshua", "Michelle", "Kenneth", "Carol", "Kevin", "Amanda", "Brian", "Melissa", "George", "Deborah", "Edward", "Stephanie", "Ronald", "Rebecca", "Timothy", "Sharon", "Jason", "Laura", "Jeffrey", "Cynthia", "Ryan", "Kathleen", "Jacob", "Amy", "Gary", "Angela", "Nicholas", "Shirley", "Eric", "Anna", "Jonathan", "Brenda", "Stephen", "Pamela", "Larry", "Nicole", "Justin", "Emma", "Scott", "Samantha", "Brandon", "Katherine", "Benjamin", "Christine", "Samuel", "Debra", "Gregory", "Rachel", "Alexander", "Catherine", "Frank", "Carolyn", "Patrick", "Janet", "Raymond", "Ruth", "Jack", "Maria", "Dennis", "Heather", "Jerry", "Diane", "Tyler", "Virginia", "Aaron", "Julie", "Jose", "Joyce", "Adam", "Victoria"]
last_names = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson", "Walker", "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores", "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell", "Carter", "Roberts", "Gomez", "Phillips", "Evans", "Turner", "Diaz", "Parker", "Cruz", "Edwards", "Collins", "Reyes", "Stewart", "Morris", "Morales", "Murphy", "Cook", "Rogers", "Gutierrez", "Ortiz", "Morgan", "Cooper", "Peterson", "Bailey", "Reed", "Kelly", "Howard", "Ramos", "Kim", "Cox", "Ward", "Richardson", "Watson", "Brooks", "Chavez", "Wood", "James", "Bennett", "Gray", "Mendoza", "Ruiz", "Hughes", "Price", "Alvarez", "Castillo", "Sanders", "Patel", "Myers", "Long", "Ross", "Foster", "Jimenez"]

# The Top 50 Specific Custodians
top_50_roles = [
    # Level 1: Command
    ("SolidStack Chief of Staff", "CA-MGR-00", "Coordinates the Executive Council and triages all direct prompts from HQ-OPR-00."),
    ("Swarm Expansion Architect", "CA-ARC-00", "Engineers the macro-scaling of the swarm ecosystem and GCP resource allocation."),
    ("Adversarial Red-Teamer", "CA-ARC-00", "Uses Doubt-Driven Development to aggressively attack and refine architectural plans before execution."),
    ("Opportunity Solution Framer", "CA-ARC-00", "Translates abstract business objectives into technical execution trees and sub-agent delegates."),
    ("Knowledge Base Librarian", "CA-HRM-00", "Transcribes successful swarm executions into permanent Markdown SOPs in the registry."),
    
    # Commanders (The Big 6)
    ("Commander of Infrastructure", "CA-MGR-01", "Oversees the Bare-Metal, Tailscale Mesh, and macOS Daemon operations."),
    ("Commander of Cognitive Routing", "VA-MGR-02", "Oversees OmniRoute, ai-proxy, and global API token economics."),
    ("Commander of Swarm Operations", "CA-MGR-03", "Oversees Google Workspace identities, DWD auth, and heuristic evasion."),
    ("Commander of Automation", "TX-MGR-04", "Oversees OpenClaw, Headless Chrome, and the Fast-Path Protocol extraction pipelines."),
    ("Commander of Intelligence", "TX-MGR-05", "Oversees mass-scraping operations, data normalization, and revenue packaging."),
    ("Commander of The Exclave", "CH-MGR-06", "Oversees the air-gapped Swiss R&D network, self-surgery, and offensive security."),

    # Routing & Proxy
    ("Lead Routing Architect", "VA-ARC-02", "Owns the OmniRoute core engine codebase and provider integration layer."),
    ("Proxy Continuity Director", "VA-ENG-02", "Ensures ai-proxy stream continuity during SolidStack self-surgery deployments."),
    ("P2C Load Balancing Engineer", "VA-ENG-02", "Mathematically tunes the routing algorithms within OmniRoute."),
    ("Token Economics Analyst", "VA-DAT-02", "Monitors API burn rates and triggers model degradation protocols."),
    ("Connection State Admin", "VA-ENG-02", "Maintains the provider_connections SQLite database locking mechanics."),

    # Infrastructure
    ("Bare-Metal Systems Lead", "CA-ENG-01", "Monitors Apple Silicon CPU/Neural Engine resources and thermal state."),
    ("Daemon Manager", "CA-ENG-01", "Writes and deploys native macOS launchd payloads (Anti-Docker protocol)."),
    ("Mesh Architect", "CA-ENG-01", "Governs the Tailscale WireGuard network connecting external nodes."),
    ("SolidStack CLI Maintainer", "CA-ENG-01", "Develops and extends the core `ss service` Python command-line utility."),

    # Automation
    ("OpenClaw Director", "TX-ARC-04", "Manages the headless task dispatch queue and parallel worker allocation."),
    ("CDP Protocol Sniper", "TX-ENG-04", "Reverses web traffic into direct API RPC calls to bypass brittle visual rendering."),
    ("Puppeteer Context Manager", "TX-ENG-04", "Manages persistent Chrome browser states and session cookies."),
    ("Extension V3 Architect", "VA-ENG-04", "Develops internal Chrome extensions ensuring CSP and Trusted Types compliance."),

    # Identity & Trust
    ("DWD Federation Lead", "CA-ARC-03", "Wields GCP Domain-Wide Delegation to manage Workspace user states."),
    ("Entra SSO Admin", "CA-ENG-03", "Manages Microsoft SAML identity bindings for external node authentication."),
    ("SSIN Cryptography Manager", "CA-ENG-03", "Generates and maintains the structural IDs for the workforce."),
    ("Corporate Trust Officer", "CA-HRM-03", "Operates HRM nodes to spoof heuristics via localized internal email chatter."),
    ("Procurement Officer", "CA-FIN-03", "Manages 1Password, Privacy.com VCCs, and binds billing to API subscriptions."),

    # Intelligence & Data
    ("Multi-Stream Strategist", "TX-ARC-05", "Paces digital asset output to generate independent revenue for SolidStack."),
    ("Mass-Scrape Architect", "TX-ENG-05", "Coordinates the Texas pods for massive intelligence gathering."),
    ("GDPR Compliance Filter", "EU-DAT-05", "Integrates EU proxy nodes for specialized intelligence while bypassing consent walls."),
    ("Data Normalization Engineer", "TX-ENG-05", "Converts unstructured web DOM scrapes into SolidStack standard JSON/SQL."),

    # Exclave (Skunkworks)
    ("Night-Cycle Evolution Lead", "CH-ARC-06", "Spawns overnight parallel pools to refactor and upgrade SolidStack codebases."),
    ("Self-Surgery Protocol Lead", "CH-ENG-06", "Develops methods for agents to safely rewrite their own system prompts."),
    ("Vulnerability Hunter", "CH-ENG-06", "Executes `hunt-tls-network` to scan external targets and internal infrastructure."),
    ("Hostile Network Penetration", "CH-ENG-06", "Researches circumvention of novel anti-bot walls (Cloudflare/Datadome).")
]

drone_templates = {
    "ENG": "Develops backend code, interacts with cloud APIs, and executes high-speed automation scripts.",
    "DAT": "Executes headless data extraction and OSINT gathering via rotating proxy pools.",
    "HRM": "Maintains heuristic trust by executing localized internal organic chatter.",
    "FIN": "Manages secure credentials and binds virtual credit cards to subscriptions.",
    "DES": "Generates multimodal assets, UI components, and digital marketing materials."
}

def generate_opaque_id(email):
    return hashlib.sha256(f"{email}:solidstack_roster_2026".encode()).hexdigest()[:8].upper()

roster = []
used_names = set()

def get_unique_name():
    while True:
        name = f"{random.choice(first_names)} {random.choice(last_names)}"
        if name not in used_names:
            used_names.add(name)
            return name

# 1. Process the Executive Hub (adamassist.com) - 49 Accounts
# Root is always Adam
roster.append({
    "email": "adam@adamassist.com",
    "name": "Adam Perecko",
    "ssin": "CA-OPR-00-M-0000X",
    "employee_id": "ROOT_APEX",
    "department": "HQ / Apex",
    "job_title": "Apex Operator (HQ-OPR-00)",
    "description": "The absolute root authority and human-in-the-loop orchestrator for the entire SolidStack Enterprise."
})

# Assign the Top 50 Custodians to adamassist (and overflow to reseller)
assigned_top_50 = 0
for i in range(1, 49):
    email = adamassist_accounts[i]
    name = get_unique_name()
    
    if assigned_top_50 < len(top_50_roles):
        title, ssin_prefix, desc = top_50_roles[assigned_top_50]
        ssin = f"{ssin_prefix}-{random.choice(['M','F'])}-{str(random.randint(100,999))}X"
        roster.append({
            "email": email, "name": name, "ssin": ssin, "employee_id": generate_opaque_id(email),
            "department": "Executive Management / Custodians", "job_title": title, "description": desc
        })
        assigned_top_50 += 1
    else:
        # Remaining adamassist get standard HQ support roles
        roster.append({
            "email": email, "name": name, "ssin": f"CA-ARC-00-{random.choice(['M','F'])}-{str(random.randint(100,999))}X",
            "employee_id": generate_opaque_id(email), "department": "Executive Support",
            "job_title": "Operations Analyst", "description": "Supports the Executive Council with telemetry and reporting."
        })

# 2. Process the Reseller Hub (reseller.mysolidstate.ca) - 296 Accounts
# We distribute these geographically and by role
distributions = [
    ("VA", "ENG", 60, "API Core (Virginia)"),
    ("TX", "DAT", 86, "Scraper Farm (Texas)"),
    ("CA", "ENG", 40, "General Ops (Canada)"),
    ("CA", "HRM", 30, "Trust & Cohesion (Canada)"),
    ("EU", "DAT", 20, "GDPR Intelligence (Europe)"),
    ("CH", "ENG", 30, "The Exclave (Switzerland)")
]

# Flatten the distribution into a queue
drone_queue = []
for loc, role, count, dept in distributions:
    for _ in range(count):
        drone_queue.append((loc, role, dept))
        
# If we have overflow, fill remaining with TX DAT
while len(drone_queue) < len(reseller_accounts):
    drone_queue.append(("TX", "DAT", "Scraper Farm (Texas)"))

for i, email in enumerate(reseller_accounts):
    name = get_unique_name()
    
    # Check if we still have top 50 roles to assign (we assigned ~38 to adamassist)
    if assigned_top_50 < len(top_50_roles):
        title, ssin_prefix, desc = top_50_roles[assigned_top_50]
        ssin = f"{ssin_prefix}-{random.choice(['M','F'])}-{str(random.randint(1000,9999))}X"
        roster.append({
            "email": email, "name": name, "ssin": ssin, "employee_id": generate_opaque_id(email),
            "department": "Specialized Command", "job_title": title, "description": desc
        })
        assigned_top_50 += 1
    else:
        loc, role, dept = drone_queue.pop(0)
        pod = str(random.randint(10, 99))
        seq = str(random.randint(1000, 9999))
        ssin = f"{loc}-{role}-{pod}-{random.choice(['M','F'])}-{seq}X"
        
        job_title = f"{role} Specialist (Pod {pod})"
        
        roster.append({
            "email": email, "name": name, "ssin": ssin, "employee_id": generate_opaque_id(email),
            "department": dept, "job_title": job_title, "description": drone_templates.get(role, "Executes automated workloads.")
        })

# Save the raw JSON database
with open(f"{ARTIFACT_DIR}/swarm_roster.json", "w") as f:
    json.dump(roster, f, indent=2)

# Generate Markdown Artifact
md = "# SolidStack Global Corporate Roster (345 Nodes)\n\n"
md += "> [!IMPORTANT]\n> This is the foundational database of every identity in the organization. These personas and job descriptions will be used to inject the `Employee ID` into Google Workspace, rename the Google Accounts, and generate the specific RAG context for their Domain Expertise.\n\n"

# Group by Department for readability in Markdown
departments = {}
for emp in roster:
    dept = emp["department"]
    if dept not in departments:
        departments[dept] = []
    departments[dept].append(emp)

for dept, emps in departments.items():
    md += f"## {dept} ({len(emps)} Personnel)\n"
    md += "| Name | Job Title | Employee ID | SSIN | Google Account |\n"
    md += "|---|---|---|---|---|\n"
    for emp in emps[:20]: # Show first 20 per department to avoid massive UI lag
        md += f"| **{emp['name']}** | {emp['job_title']} | `{emp['employee_id']}` | `{emp['ssin']}` | `{emp['email']}` |\n"
    
    if len(emps) > 20:
        md += f"| ... | *(+{len(emps)-20} more drones)* | ... | ... | ... |\n"
    md += "\n"

with open(f"{ARTIFACT_DIR}/swarm_roster.md", "w") as f:
    f.write(md)

print("Roster Database generated. 345 unique personas crafted.")
