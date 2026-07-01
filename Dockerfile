# syntax=docker/dockerfile:1

# Minimal, dependency-free image for Polycup.
# Node 18 is the minimum required version (built-in fetch).
FROM node:20-alpine

LABEL org.opencontainers.image.title="Polycup" \
      org.opencontainers.image.description="Dependency-free CLI for predicting the 2026 FIFA World Cup" \
      org.opencontainers.image.source="https://github.com/avikabra/Polycup" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Copy only the runtime files (no package install step needed).
COPY package.json LICENSE README.md ./
COPY *.js ./

# Polycup caches downloaded data as .cache_results.csv in the working directory.
# Make sure the directory is writable at runtime.
RUN chmod 755 /app

# The CLI is interactive, so keep stdin open by default.
ENTRYPOINT ["node", "polycup.js"]
