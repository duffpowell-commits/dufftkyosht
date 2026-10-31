# REA (Reverse Engineer Anything) + Ghidra + JADX, fronted by a token gateway.
# Versions and checksums are the ones REA itself pins/verifies.
FROM node:24-bookworm-slim AS node

FROM eclipse-temurin:21-jdk-noble

ARG REA_VERSION=6.8.0
ARG GHIDRA_URL=https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip
ARG GHIDRA_SHA256=ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db
ARG JADX_URL=https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar
ARG JADX_SHA256=6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75

# Node from the official image (REA needs ^24.22.1).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# procps: REA's Linux process supervisor needs a procps-compatible `ps`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps curl unzip ca-certificates python3 file \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/tools \
 && curl -fsSL --retry 3 -o /tmp/ghidra.zip "$GHIDRA_URL" \
 && echo "$GHIDRA_SHA256  /tmp/ghidra.zip" | sha256sum -c - \
 && unzip -q /tmp/ghidra.zip -d /opt/tools && rm /tmp/ghidra.zip \
 && mv /opt/tools/ghidra_* /opt/tools/ghidra \
 && curl -fsSL --retry 3 -o /opt/tools/jadx-headless-mcp.jar "$JADX_URL" \
 && echo "$JADX_SHA256  /opt/tools/jadx-headless-mcp.jar" | sha256sum -c -

RUN npm install --global "rea-agents@${REA_VERSION}" && npm cache clean --force

RUN useradd --create-home --uid 10001 rea && mkdir -p /data/targets && chown -R rea:rea /data
USER rea
WORKDIR /home/rea

ENV GHIDRA_INSTALL_DIR=/opt/tools/ghidra \
    REA_JADX_MCP_JAR=/opt/tools/jadx-headless-mcp.jar \
    REA_ANALYSIS_PROVIDER=ghidra \
    REA_MCP_OUTPUT_SCHEMA_PROFILE=off \
    UPLOAD_DIR=/data/targets \
    PORT=8080

COPY --chown=rea:rea gateway.mjs /app/gateway.mjs
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://127.0.0.1:8080/health || exit 1
CMD ["node", "/app/gateway.mjs"]
