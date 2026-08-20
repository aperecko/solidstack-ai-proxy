export class RequestThrottle {
    constructor(delayMs = 150) {
        this.delayMs = delayMs;
        this.lastRequestTime = 0;
        this.queue = Promise.resolve();
    }

    async throttle() {
        this.queue = this.queue.then(async () => {
            const now = Date.now();
            const timeSinceLast = now - this.lastRequestTime;
            if (timeSinceLast < this.delayMs) {
                await new Promise(resolve => setTimeout(resolve, this.delayMs - timeSinceLast));
            }
            this.lastRequestTime = Date.now();
        });
        return this.queue;
    }
}

export const globalThrottle = new RequestThrottle(150);
