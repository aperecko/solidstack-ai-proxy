window.Components = window.Components || {};

window.Components.processes = () => ({
    list: [],
    serviceMap: null,
    async fetchProcesses() {
        try {
            const [procRes, mapRes] = await Promise.all([
                fetch('/api/processes'),
                fetch('/api/service-map')
            ]);
            if (procRes.ok) {
                const data = await procRes.json();
                this.list = data.items || data;
            }
            if (mapRes.ok) {
                this.serviceMap = await mapRes.json();
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
                this.vms = data;
            }
            if (mobilityRes && mobilityRes.ok) {
                this.serviceMobility = await mobilityRes.json();
            }
        } catch (e) {
            console.error('Fetch failed', e);
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
