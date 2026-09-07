window.Components = window.Components || {};
window.Components.network = () => ({
    unifiClients: [],
    tailscaleNodes: [],
    wireguardPeers: [],
    cloudflareStatus: {},
    isLoading: true,
    
    async init() {
        await this.fetchNetworkData();
    },
    
    async fetchNetworkData() {
        this.isLoading = true;
        try {
            // Placeholder: Replace with actual API call when available
            // const response = await fetch('/api/network/status');
            // const data = await response.json();
            
            // Mock Data
            setTimeout(() => {
                this.unifiClients = [
                    { name: 'MacBook Pro', ip: '192.168.1.100', status: 'connected', type: 'wireless' },
                    { name: 'iPhone 13', ip: '192.168.1.101', status: 'connected', type: 'wireless' },
                    { name: 'Apple TV', ip: '192.168.1.102', status: 'connected', type: 'wired' },
                ];
                
                this.tailscaleNodes = [
                    { hostname: 'solidstack-core', ip: '100.x.y.1', status: 'online' },
                    { hostname: 'adams-macbook', ip: '100.x.y.2', status: 'online' },
                    { hostname: 'proxy-node-1', ip: '100.x.y.3', status: 'offline' },
                ];
                
                this.wireguardPeers = [
                    { name: 'peer-alpha', endpoint: '203.0.113.1', tx: '1.2 GB', rx: '3.4 GB', status: 'active' },
                    { name: 'peer-beta', endpoint: '203.0.113.2', tx: '500 MB', rx: '200 MB', status: 'active' },
                ];
                
                this.cloudflareStatus = {
                    zone: 'mysolidstate.ca',
                    tunnels: 2,
                    status: 'healthy',
                    requests24h: '1.2M'
                };
                
                this.isLoading = false;
            }, 500);
            
        } catch (error) {
            console.error('Failed to fetch network data:', error);
            this.isLoading = false;
        }
    }
});
