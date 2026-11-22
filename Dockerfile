# mockrail server image.
# Build a slim image with only some adapters by changing PROVIDERS and the deploy filter.
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build \
 && pnpm --filter @mockrail/cli deploy --prod --legacy /out

FROM node:24-alpine
WORKDIR /app
COPY --from=build /out /app
ENV HOST=0.0.0.0 PORT=4010 MOCKRAIL_PROVIDERS=bachs
EXPOSE 4010
CMD ["node", "dist/bin.js", "start", "--quiet"]
