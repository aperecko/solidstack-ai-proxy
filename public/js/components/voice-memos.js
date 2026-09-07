/**
 * Voice Memos Component for SolidStack Account Manager
 * Registers itself to window.Components for Alpine.js
 */
window.Components = window.Components || {};

window.Components.voiceMemos = () => ({
    memos: [],
    loading: false,
    error: null,
    searchQuery: '',
    totalCount: 0,
    activeAudioId: null,
    audioElement: null,
    isPlaying: false,
    playbackProgress: 0,
    playbackTimeFormatted: '0:00',
    selectedMemo: null,
    uploadStatus: null, // 'idle' | 'uploading' | 'success' | 'error'
    statusMessage: '',

    async init() {
        await this.fetchMemos();
        this.setupAudio();
    },

    setupAudio() {
        if (!this.audioElement) {
            this.audioElement = new Audio();
            this.audioElement.addEventListener('timeupdate', () => {
                if (this.audioElement.duration) {
                    this.playbackProgress = (this.audioElement.currentTime / this.audioElement.duration) * 100;
                    const mins = Math.floor(this.audioElement.currentTime / 60);
                    const secs = Math.floor(this.audioElement.currentTime % 60);
                    this.playbackTimeFormatted = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
                }
            });
            this.audioElement.addEventListener('ended', () => {
                this.isPlaying = false;
                this.activeAudioId = null;
                this.playbackProgress = 0;
            });
            this.audioElement.addEventListener('error', (e) => {
                console.error('[VoiceMemos] Playback error:', e);
                this.isPlaying = false;
            });
        }
    },

    async fetchMemos() {
        this.loading = true;
        this.error = null;
        try {
            const queryParam = this.searchQuery ? `?q=${encodeURIComponent(this.searchQuery)}` : '';
            const res = await fetch(`/api/voicememos${queryParam}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            this.memos = data.memos || [];
            this.totalCount = data.total || 0;
        } catch (err) {
            console.error('[VoiceMemos] Failed to load recordings:', err);
            this.error = err.message;
        } finally {
            this.loading = false;
        }
    },

    togglePlay(memo) {
        if (this.activeAudioId === memo.id && this.isPlaying) {
            this.audioElement.pause();
            this.isPlaying = false;
        } else if (this.activeAudioId === memo.id && !this.isPlaying) {
            this.audioElement.play();
            this.isPlaying = true;
        } else {
            this.activeAudioId = memo.id;
            this.selectedMemo = memo;
            this.audioElement.src = memo.audioUrl;
            this.audioElement.play().then(() => {
                this.isPlaying = true;
            }).catch(e => {
                console.error('[VoiceMemos] Play error:', e);
                this.isPlaying = false;
            });
        }
    },

    formatDate(isoDateString) {
        if (!isoDateString) return 'Unknown';
        try {
            const d = new Date(isoDateString);
            return d.toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch {
            return isoDateString;
        }
    },

    async copyAudioLink(memo) {
        const fullUrl = `${window.location.origin}${memo.audioUrl}`;
        try {
            await navigator.clipboard.writeText(fullUrl);
            this.showToast('Audio URL copied to clipboard!', 'success');
        } catch {
            this.showToast('Failed to copy URL', 'error');
        }
    },

    async downloadMemo(memo) {
        const link = document.createElement('a');
        link.href = memo.downloadUrl;
        link.download = memo.filename.replace(/\.qta$/i, '.m4a');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    },

    showToast(message, type = 'info') {
        if (Alpine && Alpine.store && Alpine.store('global') && Alpine.store('global').showToast) {
            Alpine.store('global').showToast(message, type);
        } else {
            console.log(`[Toast ${type}]: ${message}`);
        }
    }
});
