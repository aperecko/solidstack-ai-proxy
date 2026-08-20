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
        history: []
    },
    
    selectedEmail: null,
    selectedType: 'oauth',
    animating: false,
    pollInterval: null,
    mode: 'load_balancer',
    nativeAccount: null,
    
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
                this.nativeAccount = data.nativeAccount || null;
                
                // If there are history records, highlight the last dispatched account
                if (data.history && data.history.length > 0) {
                    const lastReq = data.history[0];
                    if (this.selectedEmail !== lastReq.email) {
                        this.triggerAnimation(lastReq.email, lastReq.email.includes('virtual-gemini-key') ? 'apikey' : 'oauth');
                    }
                    
                    this.triggerPacketAnimation();
                }
                
                this.stats = data;
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
        
        // Keep selected email highlighted for 2.5 seconds
        setTimeout(() => {
            this.animating = false;
        }, 2500);
    },
    
    triggerAnimation(email, type) {
        this.selectedEmail = email;
        this.selectedType = type;
    },

    getAccountColor(email) {
        if (!email) return '#a855f7';
        let hash = 0;
        for (let i = 0; i < email.length; i++) {
            hash = email.charCodeAt(i) + ((hash << 5) - hash);
        }
        const hue = Math.abs(hash % 360);
        return `hsl(${hue}, 95%, 60%)`;
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
