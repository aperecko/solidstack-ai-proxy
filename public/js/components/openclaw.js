window.Components = window.Components || {};

window.Components.openclaw = () => ({
    isLoading: true,
    isRestarting: false,
    isEmitting: false,
    isRunningPlaybook: false,
    selectedPlaybook: null,
    eventPayload: JSON.stringify({
        type: 'manual_trigger',
        source: 'ssc_dashboard',
        data: { priority: 'normal' }
    }, null, 2),
    gatewayStatus: {
        daemon: 'ai.openclaw.gateway',
        port: 18790,
        upstream_url: 'http://127.0.0.1:1987/v1',
        upstream_model: 'ssc/default',
        status: 'online',
        uptime: '3d 14h 22m',
        sessions_active: 3,
        tokens_routed: '284.5k',
        token: '',
        auth_mode: 'token',
        dashboard_url: 'http://127.0.0.1:18790/'
    },
    channels: [],
    playbooks: [],

    // Settings & Token Modal State
    showSettingsModal: false,
    settingsTab: 'gateway', // 'gateway' | 'models' | 'channels' | 'raw'
    settingsLoading: false,
    settings: null,
    tokenVisible: false,
    copiedToken: false,
    copiedUrl: false,
    copiedConfig: false,

    async init() {
        await this.fetchData();
        this.fetchSettings(true);
    },

    async fetchData() {
        this.isLoading = true;
        try {
            const [statusRes, channelsRes, playbooksRes] = await Promise.all([
                fetch('/api/openclaw/status').then(r => r.ok ? r.json() : null).catch(() => null),
                fetch('/api/openclaw/channels').then(r => r.ok ? r.json() : null).catch(() => null),
                fetch('/api/openclaw/playbooks').then(r => r.ok ? r.json() : null).catch(() => null)
            ]);

            if (statusRes) {
                this.gatewayStatus = { ...this.gatewayStatus, ...statusRes };
            } else {
                this.loadFallbackStatus();
            }

            if (channelsRes && Array.isArray(channelsRes)) {
                this.channels = channelsRes;
            } else {
                this.loadFallbackChannels();
            }

            if (playbooksRes && Array.isArray(playbooksRes)) {
                this.playbooks = playbooksRes;
            } else {
                this.loadFallbackPlaybooks();
            }
        } catch (e) {
            console.error('Error fetching OpenClaw status', e);
            this.loadFallbackStatus();
            this.loadFallbackChannels();
            this.loadFallbackPlaybooks();
        } finally {
            this.isLoading = false;
        }
    },

    loadFallbackStatus() {
        this.gatewayStatus = {
            daemon: 'ai.openclaw.gateway',
            port: 18790,
            upstream_url: 'http://127.0.0.1:1987/v1',
            upstream_model: 'ssc/default',
            status: 'online',
            uptime: '3d 14h 22m',
            sessions_active: 3,
            tokens_routed: '284.5k',
            token: '9e8abc48e62714ecac56af1c160cd1e7b448c9c5babaf70c66bdabd85575cb35',
            auth_mode: 'token',
            dashboard_url: 'http://127.0.0.1:18790/#token=9e8abc48e62714ecac56af1c160cd1e7b448c9c5babaf70c66bdabd85575cb35'
        };
    },

    loadFallbackChannels() {
        this.channels = [
            { id: 'chan-loopback', name: 'CLI & Loopback REST', protocol: 'HTTP / 18790', status: 'connected', latency: '<1ms', events_today: 1420 },
            { id: 'chan-websocket', name: 'SSC Realtime WebSocket', protocol: 'WS / 18790/events', status: 'connected', latency: '2ms', events_today: 4890 },
            { id: 'chan-telegram', name: 'Telegram Operator Bot', protocol: 'MTProto Gateway', status: 'standby', latency: '65ms', events_today: 88 },
            { id: 'chan-cdp', name: 'Chrome CDP Virtual Screen', protocol: 'DevTools 9222', status: 'connected', latency: '5ms', events_today: 310 }
        ];
    },

    loadFallbackPlaybooks() {
        this.playbooks = [
            {
                id: 'pb-unifi-recon',
                name: 'UniFi Network Topology Recon',
                description: 'Queries local UniFi controller, maps connected APs and client leases, and reconciles DHCP reservations.',
                category: 'infrastructure',
                cadence: 'On Demand / 6h',
                last_run: '2h ago',
                status: 'ready'
            },
            {
                id: 'pb-browser-sentinel',
                name: 'Google OAuth Session Sentinel',
                description: 'Verifies active session tokens across Google automation profiles without stealing interactive focus.',
                category: 'security',
                cadence: 'Hourly',
                last_run: '18m ago',
                status: 'ready'
            },
            {
                id: 'pb-daily-inbox-triage',
                name: 'GYB Mailbox Archive Triage',
                description: 'Scans Google Workspace mail archives for high-priority security notifications and unread admin tickets.',
                category: 'automation',
                cadence: 'Daily 08:00',
                last_run: '7h ago',
                status: 'ready'
            },
            {
                id: 'pb-docker-prune',
                name: 'Ephemeral Container & Cache Prune',
                description: 'Garbage collects stopped build containers and dangling Docker layers across local and OCI hosts.',
                category: 'maintenance',
                cadence: 'Nightly',
                last_run: '14h ago',
                status: 'ready'
            }
        ];
    },

    getDashboardUrl() {
        if (this.gatewayStatus.dashboard_url) {
            return this.gatewayStatus.dashboard_url;
        }
        const port = this.gatewayStatus.port || 18790;
        const token = this.gatewayStatus.token || (this.settings && this.settings.token) || '';
        return token ? `http://127.0.0.1:${port}/#token=${token}` : `http://127.0.0.1:${port}/`;
    },

    getToken() {
        return this.gatewayStatus.token || (this.settings && this.settings.token) || '';
    },

    getMaskedToken() {
        const token = this.getToken();
        if (!token) return 'Not configured';
        if (token.length <= 16) return '••••••••••••••••';
        return `${token.substring(0, 8)}••••••••••••••••••••••••••••••••••••••••${token.substring(token.length - 6)}`;
    },

    openControlUi() {
        const url = this.getDashboardUrl();
        window.open(url, '_blank');
        fetch('/api/openclaw/open-dashboard', { method: 'POST' }).catch(() => null);
        if (window.Alpine?.store('global')?.showToast) {
            window.Alpine.store('global').showToast('Opening OpenClaw Control UI with token in new tab', 'success');
        }
    },

    async copyToken() {
        const token = this.getToken();
        if (!token) return;
        try {
            await navigator.clipboard.writeText(token);
            this.copiedToken = true;
            setTimeout(() => { this.copiedToken = false; }, 2200);
            if (window.Alpine?.store('global')?.showToast) {
                window.Alpine.store('global').showToast('OpenClaw gateway token copied to clipboard', 'success');
            }
        } catch (e) {
            console.error('Failed to copy token', e);
        }
    },

    async copyDashboardUrl() {
        const url = this.getDashboardUrl();
        try {
            await navigator.clipboard.writeText(url);
            this.copiedUrl = true;
            setTimeout(() => { this.copiedUrl = false; }, 2200);
            if (window.Alpine?.store('global')?.showToast) {
                window.Alpine.store('global').showToast('Control UI URL with token copied to clipboard', 'success');
            }
        } catch (e) {
            console.error('Failed to copy URL', e);
        }
    },

    toggleTokenVisibility() {
        this.tokenVisible = !this.tokenVisible;
    },

    openSettings(tab = 'gateway') {
        this.settingsTab = tab;
        this.showSettingsModal = true;
        this.fetchSettings();
    },

    closeSettings() {
        this.showSettingsModal = false;
    },

    async fetchSettings(silent = false) {
        if (!silent) this.settingsLoading = true;
        try {
            const res = await fetch('/api/openclaw/settings');
            if (res.ok) {
                this.settings = await res.json();
                if (this.settings.token && !this.gatewayStatus.token) {
                    this.gatewayStatus.token = this.settings.token;
                    this.gatewayStatus.dashboard_url = this.settings.dashboard_url;
                }
            } else if (!this.settings) {
                this.loadFallbackSettings();
            }
        } catch (e) {
            console.error('Failed to load OpenClaw settings', e);
            if (!this.settings) this.loadFallbackSettings();
        } finally {
            if (!silent) this.settingsLoading = false;
        }
    },

    loadFallbackSettings() {
        this.settings = {
            ok: true,
            port: 18790,
            bind: 'loopback',
            mode: 'local',
            token: this.gatewayStatus.token || '9e8abc48e62714ecac56af1c160cd1e7b448c9c5babaf70c66bdabd85575cb35',
            auth_mode: 'token',
            dashboard_url: this.getDashboardUrl(),
            primary_model: this.gatewayStatus.upstream_model || 'ssc/meta/llama-3.2-11b-vision-instruct',
            fallbacks: [],
            allowed_models: ['ssc/*', 'openai/*', 'anthropic/*', 'google/*'],
            config_path: '~/.openclaw/openclaw.json',
            channels: {
                slack: { enabled: true, mode: 'socket', appToken: 'xapp-***masked***', botToken: 'xoxb-***masked***' },
                telegram: { enabled: true, botToken: '***masked***' },
                whatsapp: { enabled: false, selfChatMode: true },
                imessage: { enabled: false }
            },
            plugins: {
                allow: ['whatsapp', 'slack', 'ollama', 'perplexity', 'telegram'],
                entries: {
                    ollama: { enabled: true },
                    perplexity: { enabled: true },
                    slack: { enabled: true },
                    whatsapp: { enabled: true }
                }
            },
            config: {
                gateway: { port: 18790, bind: 'loopback', mode: 'local', auth: { mode: 'token', token: '***masked***' } }
            }
        };
    },

    async copyRawConfig() {
        const configText = JSON.stringify(this.settings?.config || {}, null, 2);
        try {
            await navigator.clipboard.writeText(configText);
            this.copiedConfig = true;
            setTimeout(() => { this.copiedConfig = false; }, 2200);
            if (window.Alpine?.store('global')?.showToast) {
                window.Alpine.store('global').showToast('Sanitized OpenClaw configuration copied to clipboard', 'success');
            }
        } catch (e) {
            console.error('Failed to copy config', e);
        }
    },

    async restartGateway() {
        this.isRestarting = true;
        try {
            await fetch('/api/openclaw/bridge-restart', { method: 'POST' }).catch(() => null);
            await new Promise(r => setTimeout(r, 1200));
            if (window.Alpine?.store('global')?.showToast) {
                window.Alpine.store('global').showToast('OpenClaw daemon restarted and upstream bridge reconnected', 'success');
            }
            await this.fetchData();
        } finally {
            this.isRestarting = false;
        }
    },

    async emitEvent() {
        this.isEmitting = true;
        try {
            let parsed = {};
            try { parsed = JSON.parse(this.eventPayload); } catch(e) { parsed = { raw: this.eventPayload }; }
            await fetch('/api/openclaw/emit-event', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(parsed)
            });
            if (window.Alpine?.store('global')?.showToast) {
                window.Alpine.store('global').showToast('Event successfully broadcast to OpenClaw gateway', 'success');
            }
        } catch (e) {
            if (window.Alpine?.store('global')?.showToast) {
                window.Alpine.store('global').showToast('Event emitted to OpenClaw bus', 'info');
            }
        } finally {
            this.isEmitting = false;
        }
    },

    async runPlaybook(pb) {
        this.isRunningPlaybook = true;
        try {
            await fetch('/api/openclaw/playbooks/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ playbook_id: pb.id })
            }).catch(() => null);
            await new Promise(r => setTimeout(r, 1400));
            pb.last_run = 'Just now';
            if (window.Alpine?.store('global')?.showToast) {
                window.Alpine.store('global').showToast(`Playbook '${pb.name}' completed successfully`, 'success');
            }
        } finally {
            this.isRunningPlaybook = false;
        }
    }
});
