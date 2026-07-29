# terminal-demo page container (#16 S6): build the static page with the
# repo's own toolchain, serve it with nginx. Built by Cloud Build from the
# repo root (see cloudbuild.yaml); deployed to Cloud Run on tag.
#
# Full node image, not slim: the workspace install compiles node-pty (a
# hard dep of @fsio/terminal-demo — no linux prebuilds), which needs
# python3/make/g++. It's build-stage-only weight; the runtime stage is
# nginx:alpine.
FROM node:24-bookworm AS build
WORKDIR /src
COPY . .
# Pin npm exactly like ci.yml does: the bundled npm is a different lockfile
# validator (it rejected our lock over optional-dep entries — the same
# npm-version-drift class AGENTS.md records; measured again here in the
# first Cloud Build run).
RUN npm i -g npm@11.6.1 && npm ci && npm run build

FROM nginx:1.27-alpine
COPY packages/terminal-demo/deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/packages/terminal-demo/dist-web /usr/share/nginx/html
