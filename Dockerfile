# One image definition for all three runtimes:
#   docker build --build-arg APP=api .
#   docker build --build-arg APP=outbox-publisher .
#   docker build --build-arg APP=delivery-worker .

FROM node:22-alpine AS build
RUN npm install -g pnpm@9.12.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r run build
ARG APP
RUN pnpm --filter "@relayforge/${APP}" deploy --prod /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
# Lets the API image run migrations as a one-off job (see README).
COPY db/migrations ./db/migrations
ENV MIGRATIONS_DIR=/app/db/migrations
USER node
CMD ["node", "dist/main.js"]
