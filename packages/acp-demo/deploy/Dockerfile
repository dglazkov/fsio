# acp-demo page container (#106, following terminal-demo's #16 S6): build the
# static page with the repo's own toolchain, serve it with nginx. Built by
# Cloud Build from the repo root (see cloudbuild.yaml); deployed to Cloud Run
# on tag, as its own service — see the D-entry / issue for why this page is
# not a second route on the terminal demo's host (different helper, different
# preconditions, and a subpath would mean a vite `base`).
#
# The build stage is byte-identical to terminal-demo's on purpose: Cloud
# Build's two `docker build` steps share one daemon and one context, so an
# identical instruction sequence is a layer-cache hit and the workspace is
# installed and built once, not twice.
#
# Full node image, not slim: the workspace install compiles node-pty (a hard
# dep of @fsio/terminal-demo — no linux prebuilds), which needs
# python3/make/g++. This demo needs none of it (it spawns with plain
# child_process.spawn), but `npm ci` installs the whole workspace.
FROM node:24-bookworm AS build
WORKDIR /src
COPY . .
# Pin npm exactly like ci.yml does: the bundled npm is a different lockfile
# validator (it rejected our lock over optional-dep entries — the same
# npm-version-drift class AGENTS.md records).
RUN npm i -g npm@11.6.1 && npm ci && npm run build

FROM nginx:1.27-alpine
COPY packages/acp-demo/deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/packages/acp-demo/dist-web /usr/share/nginx/html
