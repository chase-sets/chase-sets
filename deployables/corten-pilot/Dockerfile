# syntax=docker/dockerfile:1
# One image per app in the workspace: docker build --build-arg APP=admin (or marketplace) .
ARG APP=admin

FROM rust:1-bookworm AS build
ARG APP
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release -p corten-pilot-${APP} && cp target/release/corten-pilot-${APP} /server

FROM debian:bookworm-slim
ARG APP
WORKDIR /app
COPY --from=build /server /app/server
COPY ${APP}/static /app/static
ENV HOST=0.0.0.0 PORT=8080 STATIC_DIR=/app/static
EXPOSE 8080
CMD ["/app/server"]
