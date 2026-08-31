window.Components = window.Components || {};

window.Components.processes = () => ({
    list: [],
    serviceMap: null,
    async fetchProcesses() {
        try {
            const [procRes, mapRes] = await Promise.all([
                fetch('/api/processes').catch(() => null),
                fetch('/api/service-map').catch(() => null)
            ]);
            if (procRes && procRes.ok) {
                const data = await procRes.json();
                this.list = data.items || data;
            }
            if (mapRes && mapRes.ok) {
                this.serviceMap = await mapRes.json();
            }
        } catch (e) {
            console.error('Fetch processes failed', e);
        }
    },
    async toggleProcess(proc) {
        const action = proc.status === 'running' ? 'stop' : 'start';
        try {
            const res = await fetch(`/api/processes/${proc.id || proc.name}/${action}`, { method: 'POST' });
            if (res.ok) {
                if (Alpine.store('global')?.showToast) {
                    Alpine.store('global').showToast(`Process ${proc.name} ${action}ed`, 'success');
                }
                await this.fetchProcesses();
            }
        } catch (e) {
            console.error('Action failed', e);
        }
    },
    async restartProcess(proc) {
        try {
            const res = await fetch(`/api/processes/${proc.id || proc.name}/restart`, { method: 'POST' });
            if (res.ok) {
                if (Alpine.store('global')?.showToast) {
                    Alpine.store('global').showToast(`Process ${proc.name} restarted`, 'success');
                }
                await this.fetchProcesses();
            }
        } catch (e) {
            console.error('Restart failed', e);
        }
    },
    promptNewProcess() {
        const name = prompt('Enter service/daemon name to launch or ensure (e.g. pplx-gateway, turbo-fieldfare):');
        if (!name) return;
        fetch('/api/processes/launch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        }).then(r => {
            if (Alpine.store('global')?.showToast) {
                Alpine.store('global').showToast(`Service launch request sent for ${name}`, 'success');
            }
            this.fetchProcesses();
        }).catch(e => {
            if (Alpine.store('global')?.showToast) {
                Alpine.store('global').showToast(`Launch failed: ${e.message}`, 'error');
            }
        });
    },
    viewLogs(proc) {
        window.location.hash = `#logs?process=${proc.id || proc.name}`;
    },
    pollTimer: null,
    init() {
        this.fetchProcesses();
        this.pollTimer = setInterval(() => this.fetchProcesses(), 5000);
    },
    destroy() {
        if (this.pollTimer) clearInterval(this.pollTimer);
    }
});

window.Components.infrastructure = () => ({
    vms: [],
    serviceMobility: null,
    async fetchVms() {
        try {
            const [vmsRes, mobilityRes] = await Promise.all([
                fetch('/api/infrastructure/vms').catch(() => null),
                fetch('/api/service-mobility').catch(() => null)
            ]);
            if (vmsRes && vmsRes.ok) {
                const data = await vmsRes.json();
                this.vms = Array.isArray(data) ? data : (data.vms || []);
            }
            if (mobilityRes && mobilityRes.ok) {
                this.serviceMobility = await mobilityRes.json();
            }
        } catch (e) {
            console.error('Fetch infrastructure failed', e);
        }
    },
    manageNode(node) {
        if (Alpine.store('global')?.showToast) {
            Alpine.store('global').showToast(`Inspecting node ${node.name || node.id || 'target'}`, 'info');
        }
    },
    pollTimer: null,
    init() {
        this.fetchVms();
        this.pollTimer = setInterval(() => this.fetchVms(), 5000);
    },
    destroy() {
        if (this.pollTimer) clearInterval(this.pollTimer);
    }
});
