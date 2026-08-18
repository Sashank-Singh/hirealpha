# HireAlpha Spectrum bots (Friend / Coworker / Cofounder).
# Select hire at runtime with HIREALPHA_BOT=friend|coworker|cofounder
FROM oven/bun:1-slim

# Coolify probes /healthz with curl/wget; slim image has neither.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Agent personalities + shared Spectrum helpers (imported by each bot)
COPY src/agents ./src/agents
COPY spectrum/shared ./spectrum/shared
COPY deploy/timezones.ts ./deploy/timezones.ts
COPY spectrum/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Install each bot's deps (separate package.json / lock). Always WORKDIR /app
# before COPY so relative destinations are not nested under the previous bot dir.
COPY spectrum/alpha/package.json spectrum/alpha/bun.lock ./spectrum/alpha/
WORKDIR /app/spectrum/alpha
RUN bun install --frozen-lockfile --production

WORKDIR /app
COPY spectrum/alpha-coworker/package.json spectrum/alpha-coworker/bun.lock ./spectrum/alpha-coworker/
WORKDIR /app/spectrum/alpha-coworker
RUN bun install --frozen-lockfile --production

WORKDIR /app
COPY spectrum/alpha-cofounder/package.json spectrum/alpha-cofounder/bun.lock ./spectrum/alpha-cofounder/
WORKDIR /app/spectrum/alpha-cofounder
RUN bun install --frozen-lockfile --production

# Bot sources last for better layer caching on code-only changes
WORKDIR /app
COPY spectrum/alpha ./spectrum/alpha
COPY spectrum/alpha-coworker ./spectrum/alpha-coworker
COPY spectrum/alpha-cofounder ./spectrum/alpha-cofounder

ENV SKIP_INTRO=1
ENV HEALTH_PORT=3000
ENV HIREALPHA_BOT=friend

EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
