FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
COPY --from=build /src/target/release/discovery-item-detail-rs /usr/local/bin/app
EXPOSE 8080
CMD ["/usr/local/bin/app"]
