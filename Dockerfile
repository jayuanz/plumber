FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

COPY server ./server
COPY web ./web
RUN npm run build

FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssh-client git tmux bash \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/bash plumber

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV WEBTERM_CWD=/home/plumber
ENV WEBTERM_SHELL=/bin/bash

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/web/dist ./web/dist

USER plumber
EXPOSE 3000

CMD ["npm", "start"]
