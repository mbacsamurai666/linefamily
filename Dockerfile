# The bot and the LIFF page ship as one image: the server serves liff/dist
# itself, so there is no second deploy and no CORS to configure.

# ---------------------------------------------------------------- build
FROM node:22-slim AS build
WORKDIR /app

# Prisma's query engine links against OpenSSL, which the slim image omits.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Dependencies first, so a code-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci
COPY liff/package.json liff/package-lock.json ./liff/
RUN npm ci --prefix liff

COPY . .

# The generated client has to exist before tsc typechecks against it.
RUN npx prisma generate
RUN npm run build
# No VITE_LIFF_ID needed: the page asks the server for it at runtime
# (see /liff/config.js), so one image works against any LIFF channel.
RUN npm run liff:build

# ---------------------------------------------------------------- runtime
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# node_modules comes over whole rather than reinstalled with --omit=dev: the
# release step runs `prisma migrate deploy`, and the Prisma CLI is a dev
# dependency.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/liff/dist ./liff/dist
# Schema and migrations, for `prisma migrate deploy` on boot.
COPY --from=build /app/src/db ./src/db
# The digest picture is drawn at runtime: it needs the mascots and, since this
# image carries no Thai font of its own, the two faces the app uses.
COPY --from=build /app/assets ./assets
COPY package.json prisma.config.ts ./

# Whatever the platform assigns wins; this is just the local default.
ENV PORT=3000
EXPOSE 3000

USER node
CMD ["npm", "run", "start:migrate"]
