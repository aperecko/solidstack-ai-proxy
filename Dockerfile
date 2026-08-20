FROM node:20-slim

WORKDIR /app

# Copy package.json and lockfile
COPY package*.json ./

# Install dependencies (this also runs the prepare script for tailwind)
RUN npm install --ignore-scripts

# Copy application source
COPY . .

# Start the proxy
CMD ["npm", "start"]
