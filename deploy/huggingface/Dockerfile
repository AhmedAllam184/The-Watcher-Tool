# The Watcher on a Hugging Face Docker Space (free "CPU basic" hardware).
# Copy this file and README.md from this folder into the Space. It holds no
# keys: they are Space secrets, read only when the app starts. See
# docs/HOSTING.md.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Hugging Face runs the container as uid 1000, which is the image's "node" user.
USER node
RUN mkdir -p /home/node/app
WORKDIR /home/node/app

ARG WATCHER_REPO=https://github.com/AhmedAllam184/The-Watcher-Tool.git
ARG WATCHER_BRANCH=claude/upbeat-volta-volh6b
RUN git clone --depth 1 --single-branch --branch "$WATCHER_BRANCH" "$WATCHER_REPO" . \
  && npm ci --no-audit --no-fund

ENV GEV_HOSTED=1 \
  PORT=7860 \
  WATCHER_BRANCH=$WATCHER_BRANCH
EXPOSE 7860

# Run a copy: the start script updates the checkout it lives in.
CMD ["sh", "-c", "cp deploy/huggingface/start.sh /tmp/watcher-start.sh && exec sh /tmp/watcher-start.sh"]
