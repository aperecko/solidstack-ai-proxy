module.exports = {
  apps: [{
    name: 'ai-proxy',
    script: 'src/index.js',
    cwd: __dirname,
    instances: 1,
    // The proxy owns long-lived SSE streams. Fork mode avoids PM2 cluster
    // handoff races and duplicate listeners during reloads.
    exec_mode: 'fork',
    wait_ready: true,     // Wait for 'process.send("ready")' before killing old instance
    listen_timeout: Number(process.env.LISTEN_TIMEOUT || 10000), // Wait up to 10s for new instance ready
    kill_timeout: Number(process.env.KILL_TIMEOUT || process.env.STREAM_DRAIN_TIMEOUT_MS || 10000), // Keep reloads bounded; active clients can reconnect safely
    env: {
      NODE_ENV: 'production'
    }
  }]
};
