# Single-container deployment: one Node process serves both the API and the
# built web app on one port. Requires ffmpeg for the video engine.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV WEB_DIST_PATH=/app/web/dist

EXPOSE 10000
# --expose-gc: the export routes call global.gc() between heavy phases
# (each keyframe's compositing, each video's continuous sequence) to
# encourage prompt release of large raw-image buffers rather than waiting
# on V8's own heuristics — meaningful headroom on the free tier's ~512MB.
CMD ["node", "--expose-gc", "server/dist/index.js"]
