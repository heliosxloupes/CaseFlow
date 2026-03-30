FROM node:20-bookworm-slim

# Base utils needed by playwright's --with-deps installer
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

# Download Chromium and install ALL required system dependencies automatically
RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 3001

CMD ["node", "index.js"]
