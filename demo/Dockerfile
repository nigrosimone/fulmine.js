# trixie, not bookworm: uWebSockets.js ships prebuilt binaries needing GLIBC >= 2.38, and it is
# installed from GitHub rather than npm, so the build stage needs git. The runtime stage does not.
FROM node:26-trixie AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
# the Angular toolchain is a third of a gigabyte and none of it runs in production
RUN npm prune --omit=dev

FROM node:26-trixie-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/fulmine-demo/server/server.mjs"]
