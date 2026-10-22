# Alien Factory — scanner + dashboard deployment (no Devin agents in the
# image: `devin acp` needs Devin Desktop + a browser sign-in).
# Multi-stage build
# Stage 1: install everything, build the client bundle
FROM node:22-alpine AS builder

WORKDIR /app

# Copy manifests first — install layer caches unless deps change
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci

COPY . .
RUN npm run build -w client

# Stage 2: runtime — prod deps only (incl. tsx, the server has no build step)
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    ALIEN_FACTORY_NO_DEVIN=1 \
    ALIEN_FACTORY_AUTOSCAN=1 \
    ALIEN_FACTORY_DATA_DIR=/data

COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/client/dist ./client/dist
COPY shared ./shared
COPY server/src ./server/src

# Railway assigns PORT; ALIEN_FACTORY_PASSWORD must be set in the service env.
# No VOLUME instruction — Railway rejects it; attach a Railway volume at /data.
EXPOSE 8080
CMD ["npx", "tsx", "server/src/main.ts"]
