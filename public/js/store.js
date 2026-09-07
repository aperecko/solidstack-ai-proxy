/**
 * Global Store for Antigravity Console
 * Handles Translations, Toasts, and Shared Config
 */

document.addEventListener('alpine:init', () => {
    Alpine.store('global', {
        init() {
            // Hash-based routing
            const validTabs = [
                'dashboard', 'models', 'accounts', 'logs', 'settings', 'processes', 'infrastructure',
                'skills', 'agent-skills', 'capabilities', 'challenges', 'character', 'daemons-cadence',
                'demos-proficiency', 'intent-lifecycle', 'keyring', 'load-balancer', 'memory',
                'philosophy', 'playbooks-experiments', 'agent-chat', 'overnight', 'uad', 'workflow',
                'economics', 'swarm', 'research', 'prompt', 'evolution', 'consideration', 'alignment',
                'audit', 'ui-evolution', 'network', 'openclaw', 'workspace', 'containment', 'compute',
                'telemetry', 'voicememos'
            ];
            const validSettingsTabs = ['ui', 'claude', 'models', 'server'];
            const getHash = () => window.location.hash.substring(1);

            const parseHash = (hash) => {
                let [tab, subtab] = hash.split('/');
                if (tab === 'skills') tab = 'agent-skills';
                return { tab, subtab };
            };

            // 1. Initial load from hash
            const { tab: initialTab, subtab: initialSubtab } = parseHash(getHash());
            if (validTabs.includes(initialTab)) {
                this.activeTab = initialTab;
                if (initialTab === 'settings' && validSettingsTabs.includes(initialSubtab)) {
                    this.settingsTab = initialSubtab;
                }
            }

            // 2. Sync State -> URL
            Alpine.effect(() => {
                if (!validTabs.includes(this.activeTab)) return;
                let target = this.activeTab;
                if (this.activeTab === 'settings' && this.settingsTab !== 'ui') {
                    target = `settings/${this.settingsTab}`;
                }
                if (getHash() !== target) {
                    window.location.hash = target;
                }
            });

            // 3. Sync URL -> State (Back/Forward buttons)
            window.addEventListener('hashchange', () => {
                const { tab, subtab } = parseHash(getHash());
                if (validTabs.includes(tab)) {
                    if (this.activeTab !== tab) {
                        this.activeTab = tab;
                    }
                    if (tab === 'settings') {
                        this.settingsTab = validSettingsTabs.includes(subtab) ? subtab : 'ui';
                    }
                }
            });

            // 4. Fetch version from API
            this.fetchVersion();
        },

        async fetchVersion() {
            try {
                const response = await fetch('/api/config');
                if (response.ok) {
                    const data = await response.json();
                    if (data.version) {
                        this.version = data.version;
                    }
                    // Update maxAccounts in data store
                    if (data.config && typeof data.config.maxAccounts === 'number') {
                        Alpine.store('data').maxAccounts = data.config.maxAccounts;
                    }
                }
            } catch (error) {
                console.debug('Could not fetch version:', error);
            }
        },

        // App State
        version: '1.0.0',
        activeTab: 'dashboard',
        settingsTab: 'ui',
        showCommandPalette: false,
        commandSearch: '',
        webuiPassword: localStorage.getItem('antigravity_webui_password') || '',

        // i18n
        lang: localStorage.getItem('app_lang') || 'en',
        translations: window.translations || {},

        // Toast Messages
        toast: null,

        // OAuth Progress
        oauthProgress: {
            active: false,
            current: 0,
            max: 60,
            cancel: null
        },

        t(key, params = {}) {
            let str = this.translations[this.lang][key] || key;
            if (typeof str === 'string') {
                Object.keys(params).forEach(p => {
                    str = str.replace(`{${p}}`, params[p]);
                });
            }
            return str;
        },

        // Cognitive Lens & Philosophy
        cognitiveLens: localStorage.getItem('solidstack_lens') || 'commander',
        showCopilotDrawer: false,
        copilotViewContext: '',
        activeFocusTarget: localStorage.getItem('solidstack_focus_target') || '',

        lensDictionary: {
            commander: {
                nav_dashboard: 'Overview & Radar',
                nav_accounts: 'Identity & Fleet',
                nav_models: 'Model Routing & Quotas',
                nav_capabilities: 'Capabilities & Gateways',
                nav_economics: 'Retail Arbitrage Ledger',
                nav_uad: 'Universal Action Dispatcher',
                nav_workflow: 'Task Workflow & Queue',
                nav_processes: 'Process Orchestrator',
                nav_infrastructure: 'VM Mobility & Deployments',
                nav_skills: 'Containment Vault & Focus',
                nav_philosophy: 'Philosophy & Cognitive Lens',
                nav_agent_chat: 'Multi-Agent Console',
                nav_overnight: 'Overnight Mutation Loop',
                nav_logs: 'Real-Time Log Stream',
                slot_core: 'Command Core (19870)',
                slot_accounts: 'Identity Vault (19871)',
                slot_swarm: 'Mesh Swarm (19872)',
                slot_agents: 'Agent Runtime (19873)',
                slot_mcp: 'Action Dispatcher (19874)',
                slot_observability: 'Telemetry Engine (19875)',
                slot_providers: 'Provider Ingress (19876)',
                slot_compute: 'Local Compute (19877)',
                slot_jobs: 'Mutation Scheduler (19878)',
                slot_expansion: 'Reserved Expansion (19879)'
            },
            architect: {
                nav_dashboard: 'Structural Blueprint',
                nav_accounts: 'Access Pillars & Keyrings',
                nav_models: 'Distribution Beams',
                nav_capabilities: 'Module Interfaces',
                nav_economics: 'Materials & Cost Analysis',
                nav_uad: 'Scaffolding Actuators',
                nav_workflow: 'Construction Phases',
                nav_processes: 'Structural Foundations',
                nav_infrastructure: 'Physical Site Survey',
                nav_skills: 'Architectural Vault & Intent',
                nav_philosophy: 'Design Principles & Theory',
                nav_agent_chat: 'Drafting Room Dialogue',
                nav_overnight: 'Stress Test Cycles',
                nav_logs: 'Inspection Audit Trail',
                slot_core: 'Foundation Footing (19870)',
                slot_accounts: 'Security Threshold (19871)',
                slot_swarm: 'Load-Bearing Grid (19872)',
                slot_agents: 'Artisan Crew (19873)',
                slot_mcp: 'Modular Joinery (19874)',
                slot_observability: 'Strain Gauges (19875)',
                slot_providers: 'Material Supply Line (19876)',
                slot_compute: 'Heavy Fabrication (19877)',
                slot_jobs: 'Iterative Revision Loop (19878)',
                slot_expansion: 'Future Wing Reserve (19879)'
            },
            blacksmith: {
                nav_dashboard: 'Hearth & Bellows Overview',
                nav_accounts: 'Ingot & Crucible Registry',
                nav_models: 'Temper & Strike Routes',
                nav_capabilities: 'Forge Tool Racks',
                nav_economics: 'Slag vs Pure Ore Ledger',
                nav_uad: 'Tongs & Power Hammer',
                nav_workflow: 'Workpiece Queue',
                nav_processes: 'Crucible Heat Controllers',
                nav_infrastructure: 'Anvil Blocks & Quench Tanks',
                nav_skills: 'Idea Crucible & Focus Anvil',
                nav_philosophy: 'Metallurgical Invariants',
                nav_agent_chat: 'Apprentice Bench',
                nav_overnight: 'Annealing & Hardening Loop',
                nav_logs: 'Sparks & Combustion Stream',
                slot_core: 'The Great Anvil (19870)',
                slot_accounts: 'Crucible Ingot Vault (19871)',
                slot_swarm: 'Bellows Airway Mesh (19872)',
                slot_agents: 'Journeyman Strikers (19873)',
                slot_mcp: 'Tooling Rack & Tongs (19874)',
                slot_observability: 'Pyrometer Gauges (19875)',
                slot_providers: 'Ore Deliveries (19876)',
                slot_compute: 'Hydraulic Press (19877)',
                slot_jobs: 'Nightly Annealing (19878)',
                slot_expansion: 'Secondary Furnace (19879)'
            },
            pilot: {
                nav_dashboard: 'Cockpit Flight Deck',
                nav_accounts: 'Fuel Cells & Transponders',
                nav_models: 'Thrust Vector Routing',
                nav_capabilities: 'Avionics Instruments',
                nav_economics: 'Fuel Efficiency & Burn Rate',
                nav_uad: 'Fly-By-Wire Actuators',
                nav_workflow: 'Flight Plan & Checklists',
                nav_processes: 'Engine Telemetry & Turbines',
                nav_infrastructure: 'Airframes & Waypoints',
                nav_skills: 'Holding Pattern & Vector Lock',
                nav_philosophy: 'Aerodynamic Invariants',
                nav_agent_chat: 'Air Traffic Control',
                nav_overnight: 'Wind Tunnel Simulation',
                nav_logs: 'Black Box Data Stream',
                slot_core: 'Flight Computer (19870)',
                slot_accounts: 'Transponder IFF (19871)',
                slot_swarm: 'Formation Mesh (19872)',
                slot_agents: 'Autopilot Co-Pilots (19873)',
                slot_mcp: 'Flight Surface Actuators (19874)',
                slot_observability: 'Avionics Sensors (19875)',
                slot_providers: 'Satellite Upstream (19876)',
                slot_compute: 'Main Afterburner (19877)',
                slot_jobs: 'Autonomous Hold Orbit (19878)',
                slot_expansion: 'Auxiliary Fuel Tank (19879)'
            }
        },

        setCognitiveLens(lens) {
            if (this.lensDictionary[lens]) {
                this.cognitiveLens = lens;
                localStorage.setItem('solidstack_lens', lens);
                this.showToast(`Cognitive Lens switched to ${lens.toUpperCase()}`, 'info');
            }
        },

        getLensTerm(key) {
            const current = this.lensDictionary[this.cognitiveLens] || this.lensDictionary.commander;
            return current[key] || this.lensDictionary.commander[key] || key;
        },

        setActiveFocusTarget(target) {
            this.activeFocusTarget = target;
            localStorage.setItem('solidstack_focus_target', target);
        },

        toggleCopilot() {
            this.showCopilotDrawer = !this.showCopilotDrawer;
        },

        setLang(l) {
            this.lang = l;
            localStorage.setItem('app_lang', l);
        },

        showToast(message, type = 'info') {
            const id = Date.now();
            this.toast = { message, type, id };
            setTimeout(() => {
                if (this.toast && this.toast.id === id) this.toast = null;
            }, 3000);
        }
    });
});
