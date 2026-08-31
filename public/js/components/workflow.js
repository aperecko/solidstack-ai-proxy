window.Components = window.Components || {};
window.Components.workflow = () => ({
    activeTasks: [],
    pendingTasks: [],
    completedTasks: [],
    ownerRemediation: null,
    determination: null,
    isSyncing: false,
    selectedRole: 'all',
    showAllCompleted: false,

    get roles() {
        const set = new Set();
        [...this.activeTasks, ...this.pendingTasks, ...this.completedTasks].forEach(t => {
            if (t.role) set.add(t.role);
        });
        return ['all', ...Array.from(set)];
    },

    get filteredActive() {
        return this.activeTasks.filter(t => this.selectedRole === 'all' || t.role === this.selectedRole);
    },

    get filteredPending() {
        return this.pendingTasks.filter(t => this.selectedRole === 'all' || t.role === this.selectedRole);
    },

    get filteredCompleted() {
        const list = this.completedTasks.filter(t => this.selectedRole === 'all' || t.role === this.selectedRole);
        return this.showAllCompleted ? list : list.slice(0, 6);
    },

    async fetchStatus() {
        try {
            const [res, remRes, detRes] = await Promise.all([
                fetch('/api/workflow/status').catch(() => null),
                fetch('/api/owner-remediation').catch(() => null),
                fetch('/api/determination').catch(() => null)
            ]);
            
            if (res && res.ok) {
                const data = await res.json();
                const tasks = data.tasks || [];
                this.activeTasks = tasks.filter(t => t.status === 'active' || t.status === 'in-progress');
                this.pendingTasks = tasks.filter(t => t.status === 'pending');
                this.completedTasks = tasks.filter(t => t.status === 'complete' || t.status === 'completed');
            }
            if (remRes && remRes.ok) {
                this.ownerRemediation = await remRes.json();
            }
            if (detRes && detRes.ok) {
                this.determination = await detRes.json();
            }
        } catch (e) {
            console.error('Fetch workflow failed', e);
        }
    },

    async syncWorkflow() {
        this.isSyncing = true;
        try {
            const res = await fetch('/api/workflow/sync', { method: 'POST' });
            if (res.ok) {
                if (Alpine.store('global')?.showToast) {
                    Alpine.store('global').showToast('Workflow synchronized with TASK_QUEUE.md', 'success');
                }
            }
            await this.fetchStatus();
        } catch (e) {
            console.error('Sync failed', e);
        } finally {
            this.isSyncing = false;
        }
    },

    copyRemediation(text) {
        if (!text) return;
        navigator.clipboard.writeText(text);
        if (Alpine.store('global')?.showToast) {
            Alpine.store('global').showToast('Remediation command copied to clipboard', 'success');
        }
    },

    async executeRemediation(item) {
        const cmd = item.remediation || item.recommended_command;
        if (!cmd) return;
        if (Alpine.store('global')?.showToast) {
            Alpine.store('global').showToast(`Dispatching auto-fix for ${item.owner}...`, 'info');
        }
        try {
            await fetch('/api/actions/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'remediate_blocker', payload: { command: cmd, owner: item.owner } })
            }).catch(() => null);

            await this.syncWorkflow();
            if (Alpine.store('global')?.showToast) {
                Alpine.store('global').showToast(`Remediation dispatched for ${item.owner}!`, 'success');
            }
        } catch (e) {
            if (Alpine.store('global')?.showToast) {
                Alpine.store('global').showToast(`Remediation failed: ${e.message}`, 'error');
            }
        }
    },

    init() {
        this.fetchStatus();
    }
});
