window.Components = window.Components || {};

window.Components.processes = () => ({
    list: [],
    async fetchProcesses() {
        try {
            const res = await fetch('/api/processes');
            if (res.ok) {
                const data = await res.json();
                this.list = data.items || data;
            }
        } catch (e) {
            console.error('Fetch failed', e);
        }
    },
    async toggleProcess(proc) {
        const action = proc.status === 'running' ? 'stop' : 'start';
        try {
            const res = await fetch(`/api/processes/${proc.id}/${action}`, { method: 'POST' });
            if (res.ok) {
                await this.fetchProcesses();
            }
        } catch (e) {
            console.error('Action failed', e);
        }
    },
    viewLogs(proc) {
        window.location.hash = `#logs?process=${proc.id}`;
    },
    init() {
        this.fetchProcesses();
        setInterval(() => this.fetchProcesses(), 5000);
    }
});

window.Components.infrastructure = () => ({
    vms: [],
    async fetchVms() {
        try {
            const res = await fetch('/api/infrastructure/vms');
            if (res.ok) {
                const data = await res.json();
                this.vms = data;
            }
        } catch (e) {
            console.error('Fetch failed', e);
        }
    },
    init() {
        this.fetchVms();
        setInterval(() => this.fetchVms(), 5000);
    }
});
