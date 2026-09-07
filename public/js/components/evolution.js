window.Components = window.Components || {};

window.Components.evolution = () => ({
    status: {
        running: false,
        total_cycles: 0,
        merged_cycles: 0,
        discarded_cycles: 0,
        latest_reasoning: ''
    },
    iterations: [],
    capabilities: [],
    isLoading: true,
    error: null,
    pollingInterval: null,

    async init() {
        await this.fetchData();
        // Poll every 5s since Lorax mutations happen in background
        this.pollingInterval = setInterval(() => this.fetchData(), 5000);
    },

    destroy() {
        if (this.pollingInterval) clearInterval(this.pollingInterval);
    },

    async fetchData() {
        try {
            const [statusRes, matrixRes] = await Promise.all([
                fetch('/api/evolution/status').then(r => r.json()).catch(() => null),
                fetch('/api/capability/matrix').then(r => r.json()).catch(() => null)
            ]);

            if (statusRes) {
                this.status = {
                    running: statusRes.running,
                    total_cycles: statusRes.total_cycles || 0,
                    merged_cycles: statusRes.merged_cycles || 0,
                    discarded_cycles: statusRes.discarded_cycles || 0,
                    latest_reasoning: statusRes.latest_reasoning || ''
                };
                
                // Show most recent first
                this.iterations = (statusRes.iterations || []).reverse();
            }

            if (matrixRes && matrixRes.nodes) {
                // Filter to just the auto-capabilities synthesized by Lorax
                this.capabilities = matrixRes.nodes
                    .filter(n => n.id && n.id.startsWith('auto-capability'))
                    .sort((a, b) => b.id.localeCompare(a.id));
            }

            this.error = null;
        } catch (e) {
            console.error('Failed to fetch evolution telemetry', e);
            this.error = 'Failed to load telemetry data';
        } finally {
            this.isLoading = false;
        }
    },
    
    get successRate() {
        if (this.status.total_cycles === 0) return 0;
        return Math.round((this.status.merged_cycles / this.status.total_cycles) * 100);
    }
});
