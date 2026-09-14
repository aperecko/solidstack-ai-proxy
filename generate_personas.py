import json
import hashlib
import random

# Seed for reproducibility on these 13 accounts
random.seed(2026)

accounts = [
    f"{str(i).zfill(2)}@adamassist.com" for i in range(1, 13)
] + ["48@adamassist.com"]

# Persona mappings for high heuristic realism
locations = {
    'TX': {'name': 'Dallas, US', 'proxy': 'dfw.socks.privado.io', 'names': {'M': ['James Miller', 'Michael Davis'], 'F': ['Elena Rodriguez', 'Maria Garcia'], 'N': ['Taylor Brooks', 'Casey Smith']}},
    'NY': {'name': 'New York, US', 'proxy': 'ny.socks.privado.io', 'names': {'M': ['Marcus Johnson', 'David Kim'], 'F': ['Sarah Chen', 'Maya Rossi'], 'N': ['Avery Williams', 'Riley Jones']}},
    'CA': {'name': 'Montreal, CA', 'proxy': 'yul.socks.privado.io', 'names': {'M': ['David Tremblay', 'Lucas Dubois'], 'F': ['Chloe Martin', 'Sophie Roy'], 'N': ['Jordan Lee', 'Quinn Taylor']}},
    'UK': {'name': 'London, UK', 'proxy': 'lhr.socks.privado.io', 'names': {'M': ['Oliver Brown', 'Jack Wilson'], 'F': ['Emma Davies', 'Sophie Wright'], 'N': ['Jamie Evans', 'Morgan Hughes']}},
    'IN': {'name': 'Mumbai, IN', 'proxy': 'bom.socks.privado.io', 'names': {'M': ['Raj Patel', 'Arjun Singh'], 'F': ['Priya Sharma', 'Ananya Gupta'], 'N': ['Kiran Desai', 'Samar Verma']}}
}

roles = {
    'ENG': ['Software Engineer', 'DevOps Engineer', 'QA Tester', 'Backend Developer'],
    'DAT': ['Data Analyst', 'OSINT Researcher', 'SEO Specialist', 'Web Scraper'],
    'ARC': ['System Architect', 'Project Manager', 'Operations Lead'],
    'HRM': ['HR Coordinator', 'Internal Communications'],
    'FIN': ['Procurement Officer', 'Financial Analyst'],
    'DES': ['UI/UX Designer', 'Creative Director']
}

# Load the zero-API locational seed datastore
with open('location_seeds.json', 'r') as f:
    location_seeds = json.load(f)

dataset = []

for idx, email in enumerate(accounts):
    # Distribute locations and roles
    loc = list(locations.keys())[idx % len(locations)]
    
    # Ensure we get a good mix of roles across the 13 accounts
    if idx == 0: role = 'HRM' # We need an HR person early to start sending emails
    elif idx == 1: role = 'FIN' # Need finance for VCCs
    elif idx in [2, 3]: role = 'ARC' # Couple of planners
    elif idx in [4, 5, 6, 7]: role = 'ENG' # Bulk engineers
    elif idx in [8, 9, 10, 11]: role = 'DAT' # Bulk data
    else: role = 'DES'
    
    demo = random.choice(['M', 'F', 'N'])
    
    # Pick a name
    full_name = random.choice(locations[loc]['names'][demo])
    first_name, last_name = full_name.split(' ')
    
    # Pick a job title
    title = random.choice(roles[role])
    
    pod = f"{random.randint(1, 5):02d}" if role not in ['HRM', 'FIN'] else "00"
    seq = f"{random.randint(100, 9999):04d}"
    
    ssin = f"{loc}-{role}-{pod}-{demo}-{seq}X"
    
    # Generate Opaque ID
    raw = f"{email}:{ssin}:solidstack_salt_2026"
    opaque_id = hashlib.sha256(raw.encode()).hexdigest()[:8].upper()
    
    # 100% API-Free Geographical Biographies
    city_seeds = location_seeds.get(loc)
    birth_hosp = random.choice(city_seeds["hospitals"])
    high_school = random.choice(city_seeds["high_schools"])
    
    # Randomly jitter their current residence within 0.05 degrees of the city center
    res_lat = birth_hosp["lat"] + random.uniform(-0.05, 0.05)
    res_lon = birth_hosp["lon"] + random.uniform(-0.05, 0.05)
    
    # Calculate plausible graduation years based on a random age between 25-45
    age = random.randint(25, 45)
    birth_year = 2026 - age
    hs_grad = birth_year + 18
    
    life_milestones = [
        { "year": birth_year, "type": "Birth Hospital", "label": birth_hosp["name"], "lat": birth_hosp["lat"], "lon": birth_hosp["lon"], "color_hex": "#FF69B4" },
        { "year": hs_grad, "type": "High School", "label": high_school["name"], "lat": high_school["lat"], "lon": high_school["lon"], "color_hex": "#FFA500" },
        { "year": 2026, "type": "Current HQ", "label": f"{title} (Residence)", "lat": res_lat, "lon": res_lon, "color_hex": "#00FA9A" }
    ]
    
    dataset.append({
        "email": email,
        "first_name": first_name,
        "last_name": last_name,
        "location": loc,
        "city": locations[loc]['name'],
        "proxy": locations[loc]['proxy'],
        "role_code": role,
        "job_title": title,
        "pod": pod,
        "demographic": demo,
        "ssin": ssin,
        "employee_id": opaque_id,
        "life_milestones": life_milestones
    })

# Write to JSON for programmatic use
with open('active_personas.json', 'w') as f:
    json.dump(dataset, f, indent=2)

# Generate Markdown table
md = "# Active Swarm Persona Dataset\n\n"
md += "| Email | Employee ID (Opaque) | SSIN (Internal) | Name | Job Title | City | Proxy Node |\n"
md += "|---|---|---|---|---|---|---|\n"

for d in dataset:
    md += f"| `{d['email']}` | **`{d['employee_id']}`** | `{d['ssin']}` | {d['first_name']} {d['last_name']} | {d['job_title']} | {d['city']} | `{d['proxy']}` |\n"

with open('active_personas.md', 'w') as f:
    f.write(md)

print("Dataset generated successfully.")
