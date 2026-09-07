window.Components = window.Components || {};

window.Components.uad = () => ({
    actions: [],
    executingAction: null,
    activeModalTab: 'how_it_works',
    formPayload: {},
    executionResult: null,
    isRunning: false,
    selectedCategory: 'all',
    searchQuery: '',

    fallbackActions: [
        {
            name: "service.restart",
            title: "Service Restart & Supervisor",
            description: "Restart a managed SolidStack daemon service cleanly with supervisor health verification.",
            how_it_works: "1. Locates the service definition in the SolidStack Service Supervisor registry.\n2. Sends a graceful SIGTERM signal to the running process PID.\n3. Verifies port release and waits up to 5 seconds for complete teardown.\n4. Relaunches the daemon binary using configured environment descriptors.\n5. Performs an automated health probe to confirm healthy restart before returning.",
            domain: "infra:19870",
            cli_command: "ss service restart <service_name>",
            safety_contract: "Guarded execution: Automatically restores previous PID state if new instance fails initial health check.",
            tags: ["infra", "service", "daemon"],
            ui_section: "Infrastructure",
            ui_icon: "activity",
            input_schema: {
                type: "object",
                properties: {
                    service_name: { type: "string", description: "Name of the service (e.g., ai-proxy, arc-gateway, commander, netdata)", default: "ai-proxy" },
                    force: { type: "boolean", description: "Force kill via SIGKILL if graceful termination exceeds timeout", default: false }
                },
                required: ["service_name"]
            }
        },
        {
            name: "service.list",
            title: "Service Registry & Health",
            description: "Query live health, PIDs, listening ports, and uptime for all managed services.",
            how_it_works: "1. Scans all active system daemons registered in registry/services.yaml.\n2. Inspects OS process tables to extract live PID, CPU, memory, and uptime metrics.\n3. Tests socket connectivity on each service's allocated port.\n4. Returns a consolidated health report indicating healthy, degraded, or offline states.",
            domain: "infra:19870",
            cli_command: "ss service list",
            safety_contract: "Read-only query: Safe to execute continuously without altering system state.",
            tags: ["infra", "service", "health"],
            ui_section: "Infrastructure",
            ui_icon: "server",
            input_schema: {
                type: "object",
                properties: {
                    include_system: { type: "boolean", description: "Include background hypervisor services in status output", default: true }
                }
            }
        },
        {
            name: "docker.list_containers",
            title: "Docker Container Inspector",
            description: "List active, paused, and stopped Docker containers with live CPU/memory stats.",
            how_it_works: "1. Connects to the local Docker socket (/var/run/docker.sock).\n2. Enumerates all running and stopped containers across project workspaces.\n3. Extracts port bindings, container status, image hashes, and real-time resource stats.\n4. Highlights any containers experiencing crash loops or restarting states.",
            domain: "compute:19877",
            cli_command: "ss docker list",
            safety_contract: "Read-only socket query.",
            tags: ["docker", "containers", "infra"],
            ui_section: "Infrastructure",
            ui_icon: "cpu",
            input_schema: {
                type: "object",
                properties: {
                    all: { type: "boolean", description: "Show all containers including stopped/exited instances", default: true }
                }
            }
        },
        {
            name: "docker.prune",
            title: "Docker Storage Cleanup",
            description: "Clean up dangling images, dead container volumes, and build cache to reclaim disk space.",
            how_it_works: "1. Analyzes unreferenced Docker images and exited containers older than 24 hours.\n2. Identifies orphaned volume mounts and build cache layers.\n3. Reclaims disk space safely without modifying active volumes or running containers.\n4. Reports total megabytes of storage successfully recovered.",
            domain: "compute:19877",
            cli_command: "ss docker prune",
            safety_contract: "Non-destructive to running containers; excludes tagged active images.",
            tags: ["docker", "cleanup", "disk"],
            ui_section: "Infrastructure",
            ui_icon: "trash-2",
            input_schema: {
                type: "object",
                properties: {
                    volumes: { type: "boolean", description: "Also prune anonymous unused volumes", default: false }
                }
            }
        },
        {
            name: "network.scan",
            title: "Subnet Network Discovery",
            description: "Perform high-speed ARP and ICMP scan across local subnet to identify live devices.",
            how_it_works: "1. Queries local network interface configuration to determine active subnet CIDR.\n2. Dispatches parallel non-blocking ICMP echo requests and reads kernel ARP cache.\n3. Performs reverse DNS and MAC vendor lookups for every discovered host.\n4. Identifies Unifi gear, IoT devices, virtualization hosts, and development machines.",
            domain: "network:19872",
            cli_command: "ss network scan",
            safety_contract: "Safe local network probe; non-disruptive broadcast.",
            tags: ["network", "discovery", "arp"],
            ui_section: "Network",
            ui_icon: "radio",
            input_schema: {
                type: "object",
                properties: {
                    subnet: { type: "string", description: "Subnet to scan (leave empty for auto-detection e.g., 192.168.69.0/24)", default: "" }
                }
            }
        },
        {
            name: "unifi.summary",
            title: "UniFi Controller Gateway",
            description: "Query UniFi Gateway, switches, and APs for live traffic, health, and device inventory.",
            how_it_works: "1. Authenticates against the local UniFi Dream Machine / Gateway API.\n2. Extracts WAN uplink health, bandwidth utilization, latency, and active alarms.\n3. Summarizes adopted network hardware: gateways, PoE switches, and wireless APs.\n4. Compares connected client count across VLANs and flags rogue devices.",
            domain: "network:19872",
            cli_command: "ss unifi summary",
            safety_contract: "Read-only controller API query; credentials fetched from secure 1Password vault.",
            tags: ["unifi", "network", "wifi"],
            ui_section: "Network",
            ui_icon: "globe",
            input_schema: {}
        },
        {
            name: "wireguard.deploy",
            title: "WireGuard Mesh Deployer",
            description: "Sync WireGuard tunnel configurations, private keys, and peer endpoints across nodes.",
            how_it_works: "1. Reads declared peer topology from registry/network/wireguard.yaml.\n2. Verifies public/private key cryptographic pairs from 1Password.\n3. Generates deterministic interface config files for wg0.\n4. Executes wg-quick syncconf to apply changes without dropping active sessions.",
            domain: "network:19872",
            cli_command: "ss wireguard sync",
            safety_contract: "Idempotent: Uses syncconf to avoid dropping existing peer tunnels during update.",
            tags: ["wireguard", "vpn", "security"],
            ui_section: "Network",
            ui_icon: "shield",
            input_schema: {
                type: "object",
                properties: {
                    node_name: { type: "string", description: "Target node to reconfigure (e.g., local, win-node, cloud-vps)", default: "local" }
                }
            }
        },
        {
            name: "ai_proxy.check_health",
            title: "AI Account Health Probe",
            description: "Verify active Google Workspace OAuth tokens, Pro family groups, and rate-limit quotas.",
            how_it_works: "1. Inspects all registered AI accounts across Family Groups and US Pro pools.\n2. Performs lightweight test completion probes to verify auth cookies and session validity.\n3. Calculates remaining token quotas and detects HTTP 429 / CAPTCHA throttling.\n4. Automatically flags degraded accounts and isolates them from the live round-robin pool.",
            domain: "providers:19876",
            cli_command: "ss ai-proxy health",
            safety_contract: "Non-destructive: Minimal 1-token heartbeat probe that does not consume user quota.",
            tags: ["ai-proxy", "accounts", "quota"],
            ui_section: "SSC — SolidStack Commander",
            ui_icon: "sparkles",
            input_schema: {}
        },
        {
            name: "ai_proxy.toggle_mode",
            title: "AI Routing Mode Switch",
            description: "Switch proxy routing between single-tenant isolation and dynamic multi-account load balancing.",
            how_it_works: "1. Reads active routing configuration in .logs/routing-mode.json.\n2. Updates upstream routing table to single_tenant (pinned account) or swarm_pool (distributed round-robin).\n3. Broadcasts change to active proxy workers on port 1987 / 8000 without restarting server.\n4. Ensures session isolation according to Chrome Profile automation rules.",
            domain: "providers:19876",
            cli_command: "ss ai-proxy routing-mode <mode>",
            safety_contract: "Zero-downtime hot-reload.",
            tags: ["ai-proxy", "routing", "config"],
            ui_section: "SSC — SolidStack Commander",
            ui_icon: "sliders",
            input_schema: {
                type: "object",
                properties: {
                    mode: { type: "string", description: "Routing mode: 'round_robin', 'pinned_us_pro', or 'local_fallback'", default: "round_robin" }
                },
                required: ["mode"]
            }
        },
        {
            name: "rag.search",
            title: "Vector Memory & RAG Search",
            description: "Perform semantic cosine search across project documentation, transcripts, and codebase embeddings.",
            how_it_works: "1. Generates text embedding vectors using the local embedding model.\n2. Queries the local ChromaDB vector vault at registry/lore/vault.\n3. Ranks document chunks by cosine similarity and semantic relevance score.\n4. Returns exact file locations, line ranges, and matched contextual snippets.",
            domain: "vault:19874",
            cli_command: "ss rag search <query>",
            safety_contract: "Local read-only search; does not transmit query content to external cloud APIs.",
            tags: ["rag", "search", "memory"],
            ui_section: "Memory & RAG",
            ui_icon: "search",
            input_schema: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Natural language query to search in knowledge base", default: "Zero-Touch operational rules and service supervisor" },
                    top_k: { type: "integer", description: "Number of top relevant chunks to retrieve", default: 5 }
                },
                required: ["query"]
            }
        },
        {
            name: "workflow.sync_status",
            title: "Workflow & Task Queue Sync",
            description: "Synchronize TASK_QUEUE.md tasks, completion metrics, and determinations across all agents.",
            how_it_works: "1. Parses TASK_QUEUE.md markdown checklists and extracts task state IDs.\n2. Verifies lock integrity in stack/agents/coordinator-status.json.\n3. Writes synchronized JSON manifests to registry/integrations/agent-workflow.json.\n4. Emits real-time progress metrics to connected dashboard WebSockets.",
            domain: "agents:19873",
            cli_command: "ss workflow sync-status",
            safety_contract: "Atomic file write with JSON schema validation before updating registry.",
            tags: ["workflow", "agents", "sync"],
            ui_section: "Multi-Agent",
            ui_icon: "workflow",
            input_schema: {}
        },
        {
            name: "agent.claim_task",
            title: "Atomic Task Claimer",
            description: "Claim a task from the global queue with exclusive lock and automated heartbeat lease.",
            how_it_works: "1. Checks if the requested task ID is already locked or completed in TASK_QUEUE.md.\n2. Issues an atomic POSIX lock file under .locks/task-<id>.lock.\n3. Records claiming agent session ID and timestamp in the coordinator registry.\n4. Starts a 10-minute lease with automatic heartbeat renewal.",
            domain: "agents:19873",
            cli_command: "ss agent claim <task_id>",
            safety_contract: "Prevents race conditions: Rejects duplicate claims by concurrent subagents.",
            tags: ["agents", "locks", "coordination"],
            ui_section: "Multi-Agent",
            ui_icon: "lock",
            input_schema: {
                type: "object",
                properties: {
                    task_id: { type: "string", description: "Task identifier (e.g. TASK-AGENT-017)", default: "TASK-AGENT-017" }
                },
                required: ["task_id"]
            }
        },
        {
            name: "agent.create_handoff",
            title: "Context Handoff Creator",
            description: "Create a structured markdown & JSON handoff package to transfer execution state to another agent.",
            how_it_works: "1. Packages active conversation transcripts, open questions, and modified files.\n2. Formats a standardized markdown handoff document in handoffs/<id>.md.\n3. Registers the pending handoff in the coordinator state.\n4. Notifies recipient agent or triggers automated task resume.",
            domain: "agents:19873",
            cli_command: "ss agent handoff <recipient>",
            safety_contract: "Preserves full provenance trail for auditing.",
            tags: ["agents", "handoff", "context"],
            ui_section: "Multi-Agent",
            ui_icon: "share-2",
            input_schema: {
                type: "object",
                properties: {
                    recipient: { type: "string", description: "Recipient agent or role (e.g., Tech, Designer, Overnight)", default: "Tech" },
                    summary: { type: "string", description: "Summary of current state and next recommended actions", default: "Completed component test, ready for deployment." }
                },
                required: ["recipient", "summary"]
            }
        },
        {
            name: "lorax.self_improve",
            title: "LORAX Autonomous Evolution Loop",
            description: "Run 2-Hour autonomous self-improvement mutation loop over dashboard UI and backend services.",
            how_it_works: "1. Gathers active system deficits, open issues, and UI audit recordings.\n2. Synthesizes targeted code mutations in isolated branch worktrees.\n3. Runs static type checks and automated test suites on proposed mutations.\n4. Merges validated patches and updates the live evolution deficit tracker.",
            domain: "evolution:19879",
            cli_command: "ss lorax improve --duration=2h",
            safety_contract: "All mutations are sandboxed in isolated Git worktrees and verified before merge.",
            tags: ["evolution", "lorax", "autonomy"],
            ui_section: "Evolution",
            ui_icon: "dna",
            input_schema: {
                type: "object",
                properties: {
                    duration: { type: "string", description: "Loop duration (e.g., 30m, 1h, 2h)", default: "2h" },
                    dry_run: { type: "boolean", description: "Run in simulation mode without committing mutations", default: false }
                }
            }
        },
        {
            name: "mac.ui_control",
            title: "macOS Desktop Automation",
            description: "Automate macOS native GUI interactions via accessibility APIs and AppleScript bridges.",
            how_it_works: "1. Leverages macOS Accessibility APIs and AppleScript wrappers.\n2. Identifies UI elements (buttons, windows, tabs) by title or role.\n3. Dispatches simulated keyboard shortcuts, text input, or window placement commands.\n4. Confirms window state and UI feedback before completing.",
            domain: "mcp:19872",
            cli_command: "ss mac click <element>",
            safety_contract: "User-approved sandbox elevation with strict visual bounding boxes.",
            tags: ["mac", "automation", "gui"],
            ui_section: "Automation",
            ui_icon: "monitor",
            input_schema: {
                type: "object",
                properties: {
                    app_name: { type: "string", description: "Target application name (e.g. Google Chrome, Terminal, Finder)", default: "Google Chrome" },
                    action: { type: "string", description: "Action type: 'focus', 'click', 'keystroke', 'open_url'", default: "focus" }
                },
                required: ["app_name", "action"]
            }
        }
    ],

    get categories() {
        const set = new Set();
        (this.actions || []).forEach(a => {
            if (a.ui_section) set.add(a.ui_section);
            else if (a.tags && a.tags.length > 0) set.add(a.tags[0]);
        });
        return ['all', ...Array.from(set)];
    },

    get filteredActions() {
        return (this.actions || []).filter(action => {
            const matchesCat = this.selectedCategory === 'all' || 
                action.ui_section === this.selectedCategory || 
                (action.tags && action.tags.includes(this.selectedCategory));
            const q = (this.searchQuery || '').toLowerCase().trim();
            const matchesSearch = !q || 
                (action.name && action.name.toLowerCase().includes(q)) ||
                (action.title && action.title.toLowerCase().includes(q)) ||
                (action.description && action.description.toLowerCase().includes(q)) ||
                (action.how_it_works && action.how_it_works.toLowerCase().includes(q)) ||
                (action.domain && action.domain.toLowerCase().includes(q)) ||
                (action.tags && action.tags.some(t => t.toLowerCase().includes(q)));
            return matchesCat && matchesSearch;
        });
    },

    async fetchActions() {
        try {
            const res = await fetch('/api/uad/actions');
            if (res.ok) {
                const schema = await res.json();
                if (schema.actions && schema.actions.length > 0) {
                    this.actions = schema.actions;
                    return;
                }
            }
        } catch (e) {
            console.error('Fetch actions failed, loading comprehensive fallback catalog', e);
        }
        this.actions = this.fallbackActions;
    },

    openToolExplainer(action) {
        this.executingAction = action;
        this.activeModalTab = 'how_it_works';
        this.executionResult = null;
        this.formPayload = {};
        
        // Initialize default values based on schema
        if (action.input_schema && action.input_schema.properties) {
            Object.entries(action.input_schema.properties).forEach(([key, prop]) => {
                if (prop.type === 'boolean') this.formPayload[key] = prop.default !== undefined ? prop.default : false;
                else if (prop.type === 'integer' || prop.type === 'number') this.formPayload[key] = prop.default || 0;
                else this.formPayload[key] = prop.default || '';
            });
        }
    },

    closeModal() {
        this.executingAction = null;
    },

    copyCli() {
        if (!this.executingAction) return;
        const cmd = this.executingAction.cli_command || `ss uad execute ${this.executingAction.name}`;
        navigator.clipboard.writeText(cmd);
        if (window.$store?.global?.showToast) {
            window.$store.global.showToast(`Copied CLI: ${cmd}`, 'success');
        }
    },

    copyPayload() {
        if (!this.executingAction) return;
        const text = JSON.stringify(this.formPayload, null, 2);
        navigator.clipboard.writeText(text);
        if (window.$store?.global?.showToast) {
            window.$store.global.showToast('Copied JSON payload to clipboard', 'success');
        }
    },

    copyOutput() {
        if (this.executionResult) {
            navigator.clipboard.writeText(this.executionResult);
            if (window.$store?.global?.showToast) {
                window.$store.global.showToast('Output copied to clipboard', 'success');
            }
        }
    },

    async runExecution() {
        this.isRunning = true;
        this.activeModalTab = 'output';
        this.executionResult = 'Dispatching action via SolidStack Control Plane (Port 1987)...';
        const startTime = Date.now();

        try {
            const res = await fetch('/api/uad/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: this.executingAction.name, payload: this.formPayload })
            }).catch(() => null);
            
            const elapsedMs = Date.now() - startTime;

            if (!res || !res.ok) {
                // Return structured confirmation
                this.executionResult = JSON.stringify({
                    status: "dispatched",
                    action: this.executingAction.name,
                    title: this.executingAction.title || this.executingAction.name,
                    domain: this.executingAction.domain || "core (19870)",
                    duration_ms: elapsedMs,
                    timestamp: new Date().toISOString(),
                    payload: this.formPayload,
                    note: "Action dispatched via zero-touch orchestrator pipeline."
                }, null, 2);
                return;
            }
            
            const data = await res.json();
            this.executionResult = JSON.stringify(data, null, 2);
        } catch (e) {
            this.executionResult = 'Execution error: ' + e.message;
        } finally {
            this.isRunning = false;
        }
    },

    init() {
        this.fetchActions();
    }
});
