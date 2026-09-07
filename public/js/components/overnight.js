window.Components = window.Components || {};

window.Components.overnight = () => ({
    status: {
        running: false,
        pid: null,
        total_cycles: 0,
        merged_cycles: 0,
        discarded_cycles: 0,
        recent_iterations: [],
        lorax_state: {}
    },
    logs: '',
    rawLog: '',
    deficits: [],
    opportunityData: { domains: {}, stats: { total: 0, pending: 0, in_progress: 0, completed: 0 } },
    claimingOpp: false,
    reclaimingOpp: false,
    selectedOppSector: 'all',
    hours: 8.0,
    testCmd: 'pytest tests/unit/test_lorax_engine.py',
    intervalSec: 30,
    loading: false,
    starting: false,
    stopping: false,
    activeSubtab: 'overview', // 'overview' | 'report' | 'raw_logs' | 'opportunities'
    pollTimer: null,

    async fetchOpportunities() {
        try {
            const res = await fetch('/api/opportunity/list');
            if (res.ok) {
                const data = await res.json();
                this.opportunityData = data;
            }
        } catch (e) {
            console.error('Failed to fetch opportunities:', e);
        }
    },

    async claimOpportunity(domain, taskName, budgetS = 1800) {
        if (this.claimingOpp) return;
        this.claimingOpp = true;
        try {
            const res = await fetch('/api/opportunity/claim', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ domain, budget_s: budgetS, claimer: 'operator_ui' })
            });
            const data = await res.json();
            if (res.ok && data.success && data.claimed) {
                if (Alpine.store('global')?.showToast) {
                    Alpine.store('global').showToast(`Claimed: ${data.claimed.task.task}`, 'success');
                }
                await this.fetchOpportunities();
            } else {
                if (Alpine.store('global')?.showToast) {
                    Alpine.store('global').showToast(`Could not claim: ${data.error || 'No match'}`, 'error');
                }
            }
        } catch (e) {
            console.error('Failed to claim opportunity:', e);
        } finally {
            this.claimingOpp = false;
        }
    },

    async reclaimLeases() {
        if (this.reclaimingOpp) return;
        this.reclaimingOpp = true;
        try {
            const res = await fetch('/api/opportunity/reclaim', { method: 'POST' });
            const data = await res.json();
            if (res.ok && data.success) {
                if (Alpine.store('global')?.showToast) {
                    Alpine.store('global').showToast(`Reclaimed ${data.count} expired lease(s)`, 'info');
                }
                await this.fetchOpportunities();
            }
        } catch (e) {
            console.error('Failed to reclaim leases:', e);
        } finally {
            this.reclaimingOpp = false;
        }
    },

    async fetchDeficits() {
        try {
            const res = await fetch('/api/evolution/deficits');
            if (res.ok) {
                const data = await res.json();
                this.deficits = data.deficits || [];
            }
        } catch (e) {
            console.error('Failed to fetch deficits:', e);
        }
    },

    async fetchStatus() {
        try {
            const res = await fetch('/api/evolution/status');
            if (res.ok) {
                this.status = await res.json();
            }
        } catch (e) {
            console.error('Failed to fetch evolution status:', e);
        }
    },

    async fetchLogs() {
        try {
            const res = await fetch('/api/evolution/logs');
            if (res.ok) {
                const data = await res.json();
                this.logs = data.logs || 'No execution report generated yet.';
                this.rawLog = data.raw || 'No raw output logs yet.';
            }
        } catch (e) {
            console.error('Failed to fetch evolution logs:', e);
        }
    },

    async startLoop() {
        if (this.starting || this.status.running) return;
        this.starting = true;

        try {
            const res = await fetch('/api/evolution/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    hours: parseFloat(this.hours) || 8.0,
                    test_cmd: this.testCmd,
                    interval_sec: parseInt(this.intervalSec, 10) || 30
                })
            });

            const data = await res.json();
            if (res.ok && (data.status === 'started' || data.status === 'already_running')) {
                if (Alpine.store('global')?.showToast) {
                    Alpine.store('global').showToast(`Lorax Overnight Loop started (PID: ${data.pid})`, 'success');
                }
                await this.fetchStatus();
                await this.fetchLogs();
                await this.fetchDeficits();
            } else {
                if (Alpine.store('global')?.showToast) {
                    Alpine.store('global').showToast(`Failed to start loop: ${data.error || 'Unknown error'}`, 'error');
                }
            }
        } catch (e) {
            if (Alpine.store('global')?.showToast) {
                Alpine.store('global').showToast(`Network error: ${e.message}`, 'error');
            }
        } finally {
            this.starting = false;
        }
    },

    async stopLoop() {
        if (this.stopping || !this.status.running) return;
        this.stopping = true;

        try {
            const res = await fetch('/api/evolution/stop', { method: 'POST' });
            const data = await res.json();
            if (res.ok) {
                if (Alpine.store('global')?.showToast) {
                    Alpine.store('global').showToast('Lorax Overnight Loop terminated and git state safely reset.', 'info');
                }
                await this.fetchStatus();
                await this.fetchLogs();
                await this.fetchDeficits();
            } else {
                if (Alpine.store('global')?.showToast) {
                    Alpine.store('global').showToast(`Failed to stop loop: ${data.error || 'Unknown'}`, 'error');
                }
            }
        } catch (e) {
            if (Alpine.store('global')?.showToast) {
                Alpine.store('global').showToast(`Error stopping loop: ${e.message}`, 'error');
            }
        } finally {
            this.stopping = false;
        }
    },

    get successRate() {
        if (!this.status.total_cycles) return 0;
        return Math.round((this.status.merged_cycles / this.status.total_cycles) * 100);
    },

    init() {
        this.fetchStatus();
        this.fetchLogs();
        this.fetchDeficits();
        this.fetchOpportunities();
        this.pollTimer = setInterval(() => {
            this.fetchStatus();
            if (this.activeSubtab !== 'overview') {
                this.fetchLogs();
            }
            if (this.activeSubtab === 'opportunities') {
                this.fetchOpportunities();
            }
            this.fetchDeficits();
        }, 5000);
    },

    destroy() {
        if (this.pollTimer) clearInterval(this.pollTimer);
    }
});
