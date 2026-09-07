window.Components = window.Components || {};
window.Components.research = () => ({
    searchQuery: '',
    isSyncing: false,
    activeSubagents: [
        { id: 'sub-001', name: 'Codebase Researcher', status: 'active', query: 'Find all references to authentication in src/', source: 'Gemma 4 (Local)', lastUpdate: '2 mins ago', logs: 'Scanned 14 files...' },
        { id: 'sub-002', name: 'Web Searcher', status: 'idle', query: 'Latest DaisyUI components', source: 'Gemini 2.5 Flash', lastUpdate: '5 mins ago', logs: 'Found 3 articles.' }
    ],
    toolCalls: [
        { id: 'call-1', tool: 'grep_search', status: 'success', duration: '240ms', args: '{"Query":"auth","SearchPath":"/Users/test/Projects/solidstack/src"}', response: '{"results": 42}' },
        { id: 'call-2', tool: 'view_file', status: 'error', duration: '12ms', args: '{"AbsolutePath":"/Users/test/Projects/solidstack/src/auth.js"}', response: '{"error": "file not found"}' }
    ],
    abbaSessions: [
        { id: 'demo-fieldfare', status: 'connected', type: 'terminal', lastActive: '1 min ago' },
        { id: 'demo-songthrush', status: 'disconnected', type: 'terminal', lastActive: '1 hr ago' }
    ],
    selectedTool: null,

    async fetchTelemetry() {
        this.isSyncing = true;
        // In a real scenario, this would fetch from an API endpoint
        setTimeout(() => {
            this.isSyncing = false;
        }, 800);
    },

    viewToolDetails(tool) {
        this.selectedTool = tool;
    },

    closeToolDetails() {
        this.selectedTool = null;
    },

    formatJSON(str) {
        if (!str) return '';
        try {
            return JSON.stringify(JSON.parse(str), null, 2);
        } catch(e) {
            return str;
        }
    },

    init() {
        this.fetchTelemetry();
    }
});
