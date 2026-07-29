# syntax=docker/dockerfile:1
#
# Lean multi-stage build with a SINGLE final runtime target (no --target):
# DEV and PROD are the same image, differing only by tag/port at run time.
# The `deps` layer is a cache anchor so warm rebuilds are sub-second.
# Final image is plain nginx serving the built static assets as a non-root
# user — no source, no node_modules, no build tooling shipped.

FROM docker.io/library/node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

FROM deps AS build
COPY . .
RUN npm run build

# Final runtime image: nginx serving /usr/share/nginx/html on container port 8080.
FROM docker.io/library/nginx:alpine AS runtime
COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist /usr/share/nginx/html
# Run unprivileged: the bundled nginx user owns only what it needs.
USER nginx
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
