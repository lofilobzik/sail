# One image: the Go game server, serving the built site and the /ws game socket on port 8080.
# Built by .github/workflows/deploy.yml for linux/amd64 and linux/arm64. The build stages run on the
# build machine's own architecture and Go cross-compiles, so no emulation is needed.

FROM --platform=$BUILDPLATFORM docker.io/library/node:24-bookworm-slim AS site
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.sim.json ./
COPY data ./data
COPY src ./src
COPY scripts ./scripts
# The commit shown in the Esc menu (.git is not in the build context); without it the menu says "dev".
ARG GIT_COMMIT
# vite build only: typecheck and tests already ran in CI before the image job.
RUN npx vite build

FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.27 AS server
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY data ./data
COPY server ./server
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags='-s -w' -o /out/sailserver ./server/cmd/sailserver
# The challenge database directory; a fresh named volume mounted on /data copies its ownership.
RUN mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot
LABEL org.opencontainers.image.source="https://github.com/lofilobzik/sail" \
      org.opencontainers.image.description="Dinghy sailing sim: Go game server plus the static site"
COPY --from=server /out/sailserver /sailserver
COPY --from=site /src/dist /srv/www
COPY --from=server --chown=65532:65532 /out/data /data
USER nonroot
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD ["/sailserver", "-healthcheck"]
ENTRYPOINT ["/sailserver", "-addr", ":8080", "-static", "/srv/www", "-db", "/data/sail.db"]
