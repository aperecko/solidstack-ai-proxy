window.Components = window.Components || {};
window.Components.economics = () => ({
    stats: {
        pools: { adam: { cad: 12.50 }, lesley: { cad: 3.20 }, swarm: { cad: 45.10 } }
    },
    savingsData: {
        dates: [],
        tokens: [],
        savings: [],
        models: []
    },
    totalTokens: 0,
    totalSavings: 0,
    loading: false,
    chart: null,

    async fetchStats() {
        this.loading = true;
        try {
            const [econRes, savingsRes] = await Promise.allSettled([
                fetch('/api/economics/stats'),
                fetch('/api/savings-history')
            ]);

            if (econRes.status === 'fulfilled' && econRes.value.ok) {
                this.stats = await econRes.value.json();
            }

            if (savingsRes.status === 'fulfilled' && savingsRes.value.ok) {
                const sData = await savingsRes.value.json();
                this.savingsData = sData;
                this.totalTokens = (sData.tokens || []).reduce((a, b) => a + Number(b || 0), 0);
                this.totalSavings = (sData.savings || []).reduce((a, b) => a + Number(b || 0), 0);
                this.$nextTick(() => {
                    this.renderChart();
                });
            }
        } catch (e) {
            console.error('Fetch economics failed', e);
        } finally {
            this.loading = false;
        }
    },

    renderChart() {
        const canvas = document.getElementById('economicsChart');
        if (!canvas || !window.Chart) return;

        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }

        const dates = (this.savingsData.dates && this.savingsData.dates.length > 0)
            ? this.savingsData.dates
            : ['Aug 25', 'Aug 26', 'Aug 27', 'Aug 28', 'Aug 29', 'Aug 30', 'Aug 31'];
        const savings = (this.savingsData.savings && this.savingsData.savings.length > 0)
            ? this.savingsData.savings
            : [0.45, 1.20, 3.80, 2.10, 4.50, 6.75, 8.20];

        const ctx = canvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 250);
        gradient.addColorStop(0, 'rgba(16, 185, 129, 0.3)');
        gradient.addColorStop(1, 'rgba(16, 185, 129, 0.0)');

        this.chart = new window.Chart(ctx, {
            type: 'line',
            data: {
                labels: dates,
                datasets: [{
                    label: 'Retail Value Generated / Saved (USD)',
                    data: savings,
                    borderColor: '#10b981',
                    borderWidth: 2,
                    backgroundColor: gradient,
                    fill: true,
                    tension: 0.35,
                    pointBackgroundColor: '#10b981',
                    pointRadius: 3,
                    pointHoverRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        backgroundColor: '#090514',
                        titleColor: '#e2e8f0',
                        bodyColor: '#34d399',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1,
                        callbacks: {
                            label: (ctx) => ` Saved: $${Number(ctx.raw || 0).toFixed(2)}`
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { color: '#64748b', font: { family: 'monospace', size: 10 } }
                    },
                    y: {
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: {
                            color: '#64748b',
                            font: { family: 'monospace', size: 10 },
                            callback: (v) => '$' + v
                        }
                    }
                }
            }
        });
    },

    init() {
        this.fetchStats();
    }
});
