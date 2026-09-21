FROM node:20-bullseye-slim

RUN apt-get update && apt-get install -y curl iptables iproute2 && \
    curl -fsSL https://tailscale.com/install.sh | sh

WORKDIR /app
COPY package.json ./
RUN npm install --production || echo "No package.json found"
COPY . .

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

CMD ["/app/entrypoint.sh"]
