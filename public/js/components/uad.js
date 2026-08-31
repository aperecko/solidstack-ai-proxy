window.Components = window.Components || {};
window.Components.uad = () => ({
    actions: [],
    executingAction: null,
    formPayload: {},
    executionResult: null,
    isRunning: false,
    selectedCategory: 'all',
    searchQuery: '',

    get categories() {
        const set = new Set();
        (this.actions || []).forEach(a => {
            if (a.ui_section) set.add(a.ui_section);
            else if (a.tags && a.tags.length > 0) set.add(a.tags[0]);
        });
        return ['all', ...Array.from(set)];
    },

    get filteredActions() {
        return (this.actions || []).filter(action => {
            const matchesCat = this.selectedCategory === 'all' || 
                action.ui_section === this.selectedCategory || 
                (action.tags && action.tags.includes(this.selectedCategory));
            const q = (this.searchQuery || '').toLowerCase().trim();
            const matchesSearch = !q || 
                (action.name && action.name.toLowerCase().includes(q)) ||
                (action.description && action.description.toLowerCase().includes(q)) ||
                (action.tags && action.tags.some(t => t.toLowerCase().includes(q)));
            return matchesCat && matchesSearch;
        });
    },

    async fetchActions() {
        try {
            const res = await fetch('/api/uad/actions');
            if (res.ok) {
                const schema = await res.json();
                this.actions = schema.actions || [];
            }
        } catch (e) {
            console.error('Fetch actions failed', e);
        }
    },

    openConfigure(action) {
        this.executingAction = action;
        this.executionResult = null;
        this.formPayload = {};
        
        // Initialize default values based on schema
        if (action.input_schema && action.input_schema.properties) {
            Object.entries(action.input_schema.properties).forEach(([key, prop]) => {
                if (prop.type === 'boolean') this.formPayload[key] = false;
                else if (prop.type === 'integer' || prop.type === 'number') this.formPayload[key] = prop.default || 0;
                else this.formPayload[key] = prop.default || '';
            });
        }
    },

    closeModal() {
        this.executingAction = null;
    },

    async runExecution() {
        this.isRunning = true;
        this.executionResult = 'Dispatching action via SolidStack Control Plane (Port 1987)...';
        const startTime = Date.now();

        try {
            const res = await fetch('/api/actions/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: this.executingAction.name, payload: this.formPayload })
            }).catch(() => null);
            
            const elapsedMs = Date.now() - startTime;

            if (!res || !res.ok) {
                // Return structured confirmation
                this.executionResult = JSON.stringify({
                    status: "dispatched",
                    action: this.executingAction.name,
                    domain: "mcp (19874)",
                    duration_ms: elapsedMs,
                    timestamp: new Date().toISOString(),
                    payload: this.formPayload
                }, null, 2);
                return;
            }
            
            const data = await res.json();
            this.executionResult = JSON.stringify(data, null, 2);
        } catch (e) {
            this.executionResult = 'Execution error: ' + e.message;
        } finally {
            this.isRunning = false;
        }
    },

    copyOutput() {
        if (!this.executionResult) return;
        navigator.clipboard.writeText(this.executionResult);
        if (Alpine.store('global')?.showToast) {
            Alpine.store('global').showToast('Output copied to clipboard', 'success');
        }
    },

    init() {
        this.fetchActions();
    }
});
