# The analysis worker. It holds a long-lived gRPC subscription to the mirror node, so it
# belongs on a container host rather than a serverless platform — this is the half of the
# system Vercel cannot run.
#
# Built as a container specifically to keep its Node runtime independent of whatever the
# host already has installed for other services.

FROM node:22-slim AS build
WORKDIR /app
# --workspaces=false: the dashboard's dependencies (next, react, recharts) are irrelevant
# here and would roughly double the image.
COPY package.json package-lock.json ./
RUN npm ci --workspaces=false --ignore-scripts
COPY tsconfig.json main.ts ./
COPY src ./src
RUN npx tsc

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --workspaces=false --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
# Credentials arrive through the environment (--env-file), never baked into the image.
CMD ["node", "dist/src/pipeline/run.js"]
