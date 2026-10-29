# syntax=docker/dockerfile:1
# One image per app in the workspace: docker build --build-arg APP=admin (or marketplace, public) .
# Run scripts/export.mjs first: platform/tokens.json and public/favicon.svg are not committed.
ARG APP=admin

FROM rust:1-bookworm AS build
ARG APP
WORKDIR /src
COPY . .
# static/ is compiled into the program (corten::assets::embed!), and a file added there with no
# code change is only picked up by a crate that compiles again: touch the sources first.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    find . -path ./target -prune -o -name '*.rs' -exec touch {} + \
    && cargo build --release -p corten-pilot-${APP} && cp target/release/corten-pilot-${APP} /server

FROM debian:bookworm-slim
ARG APP
WORKDIR /app
COPY --from=build /server /app/server
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["/app/server"]
