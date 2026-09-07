/**
 * Load Balancer Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.loadBalancer = () => ({
    stats: {
        totalRequests: 0,
        successCount: 0,
        rateLimitCount: 0,
        failureCount: 0,
        successRate: 100,
        history: [],
        strategyLabel: 'Hybrid (Smart Distribution)'
    },
    
    selectedEmail: null,
    selectedType: 'oauth',
    selectedModel: null,
    animating: false,
    pollInterval: null,
    mode: 'load_balancer',
    nativeAccount: 'adamperecko@gmail.com',
    lastHandledTimestamp: null,
    isLiveTraffic: false,
    
    init() {
        this.fetchStats();
        
        // Poll routing statistics every 2 seconds
        this.pollInterval = setInterval(() => {
            this.fetchStats();
        }, 2000);
    },
    
    destroy() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
        }
    },
    
    async fetchStats() {
        try {
            const res = await fetch('/api/routing-stats');
            if (res.ok) {
                const data = await res.json();
                this.stats = data;
                this.mode = data.mode || 'load_balancer';
                this.nativeAccount = data.nativeAccount || 'adamperecko@gmail.com';
                
                // If there are history records, check if a NEW request arrived
                if (data.history && data.history.length > 0) {
                    const lastReq = data.history[0];
                    const reqTime = new Date(lastReq.timestamp).getTime();
                    const isNew = this.lastHandledTimestamp !== lastReq.timestamp;
                    const isFresh = (Date.now() - reqTime) < 6000;
                    
                    if (isNew && isFresh) {
                        this.lastHandledTimestamp = lastReq.timestamp;
                        this.selectedEmail = lastReq.email;
                        this.selectedModel = lastReq.model || null;
                        this.selectedType = lastReq.email?.includes('virtual-gemini-key') ? 'apikey' : (lastReq.type === 'ollama' ? 'ollama' : 'oauth');
                        this.triggerPacketAnimation();
                        this.isLiveTraffic = true;
                    } else if (!isFresh) {
                        this.isLiveTraffic = false;
                    }
                    
                    // Keep last selected account recorded for visual status
                    if (!this.selectedEmail) {
                        this.selectedEmail = lastReq.email;
                        this.selectedModel = lastReq.model || null;
                        this.selectedType = lastReq.email?.includes('virtual-gemini-key') ? 'apikey' : (lastReq.type === 'ollama' ? 'ollama' : 'oauth');
                    }
                }
            }
        } catch (e) {
            console.error('Failed to fetch routing stats:', e);
        }
    },
    
    triggerPacketAnimation() {
        this.animating = false;
        // Force reflow
        setTimeout(() => {
            this.animating = true;
        }, 50);
        
        // Keep selected animation active for duration of travel
        setTimeout(() => {
            this.animating = false;
        }, 2200);
    },
    
    triggerAnimation(email, type) {
        this.selectedEmail = email;
        this.selectedType = type;
    },

    getAccountColor(email) {
        if (!email) return '#a855f7';
        if (email.includes('adamperecko')) return '#f59e0b';
        if (email.includes('assistaius')) return '#22c55e';
        if (email.includes('apps000123000')) return '#06b6d4';
        if (email.includes('aptsoultuions')) return '#3b82f6';
        if (email.includes('adamtechnicalsolutions')) return '#a855f7';
        if (email.includes('haliburtonarcher')) return '#ec4899';
        if (email.includes('adampps')) return '#eab308';
        
        let hash = 0;
        for (let i = 0; i < email.length; i++) {
            hash = email.charCodeAt(i) + ((hash << 5) - hash);
        }
        const hue = Math.abs(hash % 360);
        return `hsl(${hue}, 90%, 65%)`;
    },
    
    getStatusColor(status) {
        switch (status) {
            case 'success': return 'text-neon-green bg-neon-green/10 border-neon-green/30';
            case 'rate_limit': return 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30';
            default: return 'text-red-400 bg-red-400/10 border-red-400/30';
        }
    },
    
    getStatusText(status) {
        switch (status) {
            case 'success': return 'SUCCESS';
            case 'rate_limit': return 'THROTTLED (429)';
            default: return 'FAILED';
        }
    },

    async toggleMode() {
        const nextMode = this.mode === 'load_balancer' ? 'native_bypass' : 'load_balancer';
        this.mode = nextMode;
        try {
            const res = await fetch('/api/routing-mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: nextMode })
            });
            if (res.ok) {
                const data = await res.json();
                this.mode = data.mode || nextMode;
                await this.fetchStats();
            }
        } catch (e) {
            console.error('Failed to toggle routing mode:', e);
        }
    },

    async toggleAccount(email, enabled) {
        // Optimistic UI update on data store
        const dataStore = Alpine.store('data');
        if (dataStore && dataStore.accounts) {
            const acc = dataStore.accounts.find(a => a.email === email);
            if (acc) acc.enabled = enabled;
        }
        try {
            const res = await fetch(`/api/accounts/${encodeURIComponent(email)}/toggle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled })
            });
            if (res.ok && dataStore) {
                await dataStore.fetchData();
            }
        } catch (e) {
            console.error('Failed to toggle account enabled state:', e);
            if (dataStore) await dataStore.fetchData();
        }
    }
});
