# ============================================================================
#  HumanGate — one container, one volume, one always-on machine
# ============================================================================
#
# ── Why this image looks the way it does ───────────────────────────────────
#
#   * `bookworm-slim`, not `alpine`. `better-sqlite3` is a native module, and its
#     prebuilt binaries are built against glibc. Alpine means compiling it
#     (python3, make, g++) on every build for no benefit at this size.
#
#   * `node:22`, pinned. The Node ABI decides which prebuilt binary is
#     downloaded; a brand-new major line may not have one yet, and the fallback
#     is a source build that needs the toolchain below.
#
#   * The toolchain IS installed, in both build stages. This file originally
#     assumed `better-sqlite3` would fetch a prebuild — it did not, and the build
#     died inside `node-gyp` with "Could not find any Python installation". A
#     prebuild is a convenience, not a guarantee: it depends on the Node ABI
#     having a published binary, which is exactly the sort of thing that changes
#     without warning. ~200MB of build-only toolchain buys a build that works
#     either way, and none of it reaches the runtime image.
#
#   * No `output: 'standalone'`. It exists to shrink the runtime image and it
#     would — at the cost of hand-copying `better-sqlite3`'s `.node` binary and
#     its `node_modules` subtree past Next's tracer, because a native binding is
#     exactly the kind of dependency tracing gets wrong. Copying the built
#     `node_modules` wholesale is the boring version that cannot break.
#
#   * Secrets are NOT baked in. `HUMANGATE_SIGNING_KEY`, `WORLDID_CLIENT_SECRET`
#     and the rest arrive at run time (`fly secrets set`). RED LINE 2 depends on
#     that: a secret in a layer is a secret in every copy of the image.
#
#   * There is no `npm run seed` step, at build time or in a release command.
#     Both run without the volume, and Fly's own SQLite guidance says so. The
#     app seeds itself on the path that needs the event — see `lib/sandbox.ts`.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Build-only: compiling a native module when no prebuild matches this ABI.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
# `next build` does not compile native modules, but this stage also runs
# `npm ci` on a cold cache, and a missing toolchain would then fail the build
# step rather than the dependency step — a much more confusing place to find out.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# There is no `.env*` in this context (see .dockerignore): a developer's laptop
# copy would otherwise decide the public URL inside the image. The environment
# decides instead, at run time.
RUN npm run build

# ── The MCP server, as one self-contained file ─────────────────────────────
#
# `/admin`'s "tell the agent to buy a ticket" button spawns `mcp/server.ts` as a
# child process over stdio. In the image there was no `mcp/` directory at all —
# the runtime stage copies the built app, and this file was never part of it — so
# the child died instantly and the panel reported the only thing a dead stdio
# transport can report: `MCP error -32000: Connection closed`.
#
# Copying the sources would not work either: `mcp/server.ts` imports
# `../agent/client` as TypeScript, and the image has no interpreter for it. So it
# is bundled here into a single plain-JS file, which is also the version least
# likely to break — no source files, no path aliases, and only the MCP SDK left
# external, resolved from the runtime's `node_modules`.
RUN ./node_modules/.bin/esbuild mcp/server.ts \
      --bundle --platform=node --format=esm \
      --target=node22 \
      --external:@modelcontextprotocol/sdk \
      --outfile=dist/mcp-server.mjs \
 && printf '{"type":"module"}\n' > dist/package.json \
 && node --check dist/mcp-server.mjs \
 && echo "[build] mcp server bundled: $(wc -c < dist/mcp-server.mjs) bytes"

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    HUMANGATE_DB=/data/presence.db

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
# `next start` reads the config, and `lib/db.ts` applies `db/schema.sql` on the
# first connection — both are runtime inputs, not build artefacts.
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/instrumentation.ts ./instrumentation.ts
COPY --from=build /app/db/schema.sql ./db/schema.sql
# The bundled MCP server the agent button spawns, with the `{"type":"module"}`
# marker that lets Node read it as ESM (the app's own package.json is CommonJS
# here, which would otherwise make `.mjs`... still ESM, but the marker keeps the
# intent explicit and survives a rename).
COPY --from=build /app/dist/mcp-server.mjs ./dist/mcp-server.mjs
COPY --from=build /app/dist/package.json ./dist/package.json
COPY scripts/entrypoint.sh ./scripts/entrypoint.sh
RUN chmod +x ./scripts/entrypoint.sh && mkdir -p /data

# Fly terminates TLS and proxies here; this is the app's own port.
EXPOSE 3000

# Health is a real read of the app: `/api/health` reports the IdP mode, whether
# the URLs are consistent with the portal registration, and how many private
# events exist. A container that answers 200 here is one that can serve.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `next start`, not `next dev`: the dev server recompiles per request and the
# public demo should not pay for that.
CMD ["./scripts/entrypoint.sh"]
