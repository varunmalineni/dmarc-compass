# dmarc-compass for Docker, Kubernetes or a plain VM: one image holding the app
# (Node) and the unmodified upstream parser (a single static program), which the
# app starts once per mailbox. This is NOT the Dockerfile used for Cloudflare
# (that one is ../../Dockerfile and holds only the parser).
#
#   docker build -f deploy/docker/Dockerfile -t dmarc-compass .

# The parser, from the upstream project (MIT), run unmodified. Pinned to a release;
# Dependabot opens a PR when a new one is published. Keep this version equal to the
# one in the root Dockerfile (a test checks that they match).
FROM ghcr.io/cry-inc/dmarc-report-viewer:2.6.2 AS parser

FROM node:24-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
# Only the bundler is needed to build the server; skip the Cloudflare tooling.
RUN npm install --no-save --no-package-lock --ignore-scripts \
      "esbuild@$(node -p "require('./package.json').devDependencies.esbuild.replace(/^[^0-9]*/, '')")"
COPY scripts/build-node.mjs scripts/build-node.mjs
COPY src src
RUN node scripts/build-node.mjs

FROM node:24-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    PARSER_BIN=/usr/local/bin/dmarc-report-viewer
COPY --from=parser /dmarc-report-viewer /usr/local/bin/dmarc-report-viewer
WORKDIR /app
COPY --from=build /src/dist/server.mjs dist/server.mjs
COPY public public
# The database lives in /data: mount a volume there. The node user is uid 1000.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Exec form, so SIGTERM reaches Node and the parsers are stopped cleanly.
CMD ["node", "dist/server.mjs"]
