window.Components = window.Components || {};
window.Components.moodTracker = () => ({
    days: [],
    loading: false,
    error: null,
    lastRefreshed: null,
    slotConfig: [
        { id: 'morning', label: 'Morning', time: '11:00', order: 0 },
        { id: 'afternoon', label: 'Afternoon', time: '16:00', order: 1 },
        { id: 'evening', label: 'Evening', time: '22:00', order: 2 },
    ],

    async init() {
        await this.fetchCalendar();
    },

    async fetchCalendar() {
        this.loading = true;
        this.error = null;
        try {
            const res = await fetch('/api/moods/calendar');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            this.days = (data.days || []).map((d) => ({
                ...d,
                checkins: (d.checkins || []).sort((a, b) => a.hour - b.hour),
            }));
            this.lastRefreshed = new Date();
        } catch (err) {
            console.error('[MoodTracker] Failed to load calendar:', err);
            this.error = err.message;
        } finally {
            this.loading = false;
        }
    },

    slotMeta(id) {
        return this.slotConfig.find((s) => s.id === id) || { label: id, time: '', order: 0 };
    },

    checkinFor(d, slotId) {
        return (d.checkins || []).find((c) => c.slot === slotId) || null;
    },

    isToday(d) {
        return d.date === this.todayKey();
    },

    todayKey() {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    },

    formatDay(d) {
        const [y, m, day] = d.date.split('-');
        return `${d.weekday} ${m}/${day}`;
    },

    scoreColor(score) {
        const s = Math.max(0, Math.min(100, Number(score) || 0));
        const hue = Math.round((100 - s) * 1.2);
        const light = 38 + ((100 - s) / 100) * 16;
        return `hsl(${hue} 72% ${light}%)`;
    },

    scoreText(score) {
        const s = Number(score) || 0;
        if (s < 25) return 'Calm';
        if (s < 45) return 'Mild';
        if (s < 65) return 'Elevated';
        if (s < 85) return 'High';
        return 'Severe';
    },

    styleFor(checkin) {
        if (!checkin) return '';
        const c = this.scoreColor(checkin.score);
        return `background: ${c}; box-shadow: 0 0 18px ${c}55;`;
    },

    filledCount() {
        return this.days.reduce((n, d) => n + (d.checkins || []).length, 0);
    },

    avgScore() {
        const all = this.days.flatMap((d) => d.checkins || []);
        if (!all.length) return null;
        const sum = all.reduce((n, c) => n + (Number(c.score) || 0), 0);
        return Math.round(sum / all.length);
    },

    todayScore() {
        const d = this.days.find((x) => x.date === this.todayKey());
        if (!d) return null;
        const last = (d.checkins || [])[d.checkins.length - 1];
        return last ? last.score : null;
    },

    html(s) {
        return s || '';
    },
});