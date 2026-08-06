# trixie, not bookworm: uWebSockets.js ships prebuilt binaries needing GLIBC >= 2.38, and it is
# installed from GitHub rather than npm, so the build stage needs git. The runtime stage does not.
FROM node:26-trixie AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

FROM node:26-trixie-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY server.js ./
COPY public ./public
EXPOSE 3000
CMD ["node", "server.js"]
