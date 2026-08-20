window.Components = window.Components || {};

window.Components.swarmVisualizer = () => ({
    canvas: null,
    ctx: null,
    width: 0,
    height: 0,
    animationId: null,
    nodes: [],
    
    // Config
    nodeRadius: 4,
    nodeSpacing: 16,
    
    init() {
        this.$nextTick(() => {
            this.canvas = this.$refs.canvas;
            this.ctx = this.canvas.getContext('2d', { alpha: false });
            this.resize();
            window.addEventListener('resize', () => this.resize());
            
            // Watch accounts data
            this.$watch('$store.data.accounts', () => {
                this.updateNodes();
            });
            
            this.updateNodes();
            this.loop();
        });
    },
    
    resize() {
        if (!this.canvas) return;
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.width = rect.width;
        this.height = 300; // Fixed height for dashboard
        this.canvas.width = this.width * window.devicePixelRatio;
        this.canvas.height = this.height * window.devicePixelRatio;
        this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
        this.canvas.style.width = `${this.width}px`;
        this.canvas.style.height = `${this.height}px`;
        this.updateNodes();
    },
    
    updateNodes() {
        if (!this.width || !this.height) return;
        const accounts = Alpine.store('data').accounts || [];
        
        // Filter out 'apikey' type if needed, or keep them.
        const swarmAccounts = accounts; 
        
        // Calculate grid layout
        const cols = Math.max(1, Math.floor((this.width - this.nodeSpacing) / this.nodeSpacing));
        const startX = (this.width - (cols * this.nodeSpacing)) / 2 + (this.nodeSpacing / 2);
        const startY = 30;
        
        this.nodes = swarmAccounts.map((acc, i) => {
            const row = Math.floor(i / cols);
            const col = i % cols;
            // Stagger rows for honeycomb effect
            const offsetX = (row % 2 === 1) ? this.nodeSpacing / 2 : 0;
            
            return {
                x: startX + col * this.nodeSpacing + offsetX,
                y: startY + row * (this.nodeSpacing * 0.866), // hex height ratio
                account: acc,
                baseRadius: this.nodeRadius,
                pulseRadius: this.nodeRadius,
                pulsePhase: Math.random() * Math.PI * 2, // Random starting phase
                targetColor: this.getColorForAccount(acc)
            };
        });
    },
    
    getColorForAccount(acc) {
        if (acc.isInvalid) return '#EF4444'; // Red (Error/Invalid)
        if (acc.subscription && acc.subscription.tier === 'pro') return '#A855F7'; // Purple (Pro)
        if (acc.is_reserved) return '#EC4899'; // Pink (Reserved)
        if (acc.enabled === false) return '#4B5563'; // Gray (Disabled)
        
        // Check for hard 429 rate limits first
        if (acc.modelRateLimits) {
            for (const model of Object.values(acc.modelRateLimits)) {
                if (model.isRateLimited) return '#F97316'; // Orange (Cooldown)
            }
        }
        
        // Use limits (remainingFraction) for granular quota coloring
        const limitsObj = acc.limits || {};
        const entries = Object.entries(limitsObj).filter(([_, l]) => l !== null && l !== undefined);
        
        if (entries.length === 0) {
            // No quota data (e.g. error/uninitialized swarm accounts)
            if (acc.status === 'error') return '#374151'; // Dark Gray (Error/No Data)
            return '#22C55E'; // Green (Standby)
        }
        
        // Find the lowest remaining fraction across all models
        let lowestRemaining = 1.0;
        for (const [_, l] of entries) {
            if (l.remainingFraction !== null && l.remainingFraction !== undefined) {
                lowestRemaining = Math.min(lowestRemaining, l.remainingFraction);
            }
        }
        
        if (lowestRemaining <= 0.05) return '#F97316'; // Orange (Cooldown)
        if (lowestRemaining < 0.2) return '#EAB308'; // Yellow (Warning)
        if (lowestRemaining < 0.5) return '#3B82F6'; // Blue (Active)
        return '#22C55E'; // Green (Optimal)
    },
    
    loop() {
        if (!this.ctx) return;
        this.animationId = requestAnimationFrame(() => this.loop());
        
        // Clear background
        this.ctx.fillStyle = '#0f172a'; // space-950
        this.ctx.fillRect(0, 0, this.width, this.height);
        
        const now = Date.now();
        
        for (const node of this.nodes) {
            // Update color based on current state (in case it changed)
            node.targetColor = this.getColorForAccount(node.account);
            
            // Pulse animation for active/working nodes
            let currentRadius = node.baseRadius;
            let currentOpacity = 0.8;
            
            // If green (ready) or blue (active), give it a subtle breath
            if (node.targetColor === '#22C55E' || node.targetColor === '#3B82F6') {
                node.pulsePhase += 0.02;
                currentRadius = node.baseRadius + Math.sin(node.pulsePhase) * 1.5;
                currentOpacity = 0.6 + Math.sin(node.pulsePhase) * 0.4;
            } else if (node.targetColor === '#EAB308') {
                // Yellow (warning) - faster pulse
                node.pulsePhase += 0.03;
                currentOpacity = 0.5 + Math.sin(node.pulsePhase) * 0.3;
            } else if (node.targetColor === '#F97316') {
                // Cooldown pulses slower
                node.pulsePhase += 0.01;
                currentOpacity = 0.3 + Math.sin(node.pulsePhase) * 0.2;
            } else if (node.targetColor === '#374151') {
                // Dark gray (no data / error) - static, dim
                currentOpacity = 0.25;
            }
            
            this.ctx.beginPath();
            this.ctx.arc(node.x, node.y, currentRadius, 0, Math.PI * 2);
            
            // Parse hex color to add opacity
            this.ctx.fillStyle = this.hexToRgbA(node.targetColor, currentOpacity);
            this.ctx.fill();
        }
    },
    
    hexToRgbA(hex, alpha) {
        let c;
        if(/^#([A-Fa-f0-9]{3}){1,2}$/.test(hex)){
            c = hex.substring(1).split('');
            if(c.length === 3){
                c = [c[0], c[0], c[1], c[1], c[2], c[2]];
            }
            c = '0x' + c.join('');
            return 'rgba(' + [(c>>16)&255, (c>>8)&255, c&255].join(',') + ',' + alpha + ')';
        }
        return `rgba(255,255,255,${alpha})`;
    },
    
    destroy() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }
    }
});
