#!/bin/sh
/usr/sbin/tailscaled --state=mem: &
sleep 3
/usr/bin/tailscale up --authkey="${TAILSCALE_AUTHKEY}" --hostname=swarm-orchestrator --accept-routes
npm start || node src/index.js || python3 -m http.server 8080
