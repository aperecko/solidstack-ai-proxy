module.exports = {
  apps: [{
    name: 'ai-proxy',
    script: 'src/index.js',
    cwd: __dirname,
    instances: 1,
    // The proxy owns long-lived SSE streams. Fork mode avoids PM2 cluster
    // handoff races and duplicate listeners during reloads.
    exec_mode: 'fork',
    wait_ready: false,    // Fork mode must replace the old listener without waiting on long-lived SSE streams
    listen_timeout: Number(process.env.LISTEN_TIMEOUT || 10000),
    kill_timeout: Number(process.env.KILL_TIMEOUT || process.env.STREAM_DRAIN_TIMEOUT_MS || 3000), // Bound reloads; active clients can reconnect safely
    autorestart: true,
    restart_delay: 500,
    max_restarts: 30,
    max_memory_restart: '1G',
    min_uptime: 10000,
    env: {
      NODE_ENV: 'production',
      NODE_OPTIONS: '--use-system-ca --max-old-space-size=1024',
      FALLBACK: 'true',
      AG_NIM_OVERFLOW: '1'
    }
  }]
};
