# syntax=docker/dockerfile:1.7
# Unofficial Yosys container image
# Copyright (c) 2026 Abhilash M — MIT License (see LICENSE)

# ---------- Build stage ----------
FROM ubuntu:22.04 AS builder

ARG YOSYS_VERSION=0.69

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake ninja-build wget ca-certificates \
        gawk bison flex clang lld \
        python3 libffi-dev libfl-dev libreadline-dev pkg-config \
        tcl-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN wget -q https://github.com/YosysHQ/yosys/releases/download/v${YOSYS_VERSION}/yosys.tar.gz \
    && tar xf yosys.tar.gz --strip-components=1 \
    && rm yosys.tar.gz

RUN cmake -B build -G Ninja . \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/usr \
        -DYOSYS_WITHOUT_EDITLINE=ON \
        -DYOSYS_WITHOUT_SLANG=ON \
    && cmake --build build --parallel "$(nproc)" \
    && cmake --install build --prefix /out/usr --strip \
    && echo "===== /out/usr =====" \
    && ls -la /out/usr/ \
    && echo "===== /out/usr/bin =====" \
    && ls -la /out/usr/bin/ \
    && echo "===== /out/usr/share =====" \
    && ls -la /out/usr/share/ \
    && echo "===== end install report ====="

# ---------- Runtime stage ----------
FROM ubuntu:22.04 AS runtime

ARG YOSYS_VERSION=0.69

LABEL org.opencontainers.image.title="Yosys (unofficial)"
LABEL org.opencontainers.image.description="Standalone Yosys build from upstream source"
LABEL org.opencontainers.image.source="https://github.com/MrAbhi19/open-eda-appimage"
LABEL org.opencontainers.image.version="${YOSYS_VERSION}"
LABEL org.opencontainers.image.licenses="ISC"

ENV DEBIAN_FRONTEND=noninteractive

# Only runtime libs — no compilers, no dev headers.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libreadline8 libffi8 libtcl8.6 zlib1g \
        graphviz xdot \
    && rm -rf /var/lib/apt/lists/*

# Bring in the Yosys files built in the previous stage.
COPY --from=builder /out/usr/ /usr/

# Yosys looks here for its techlibs / cells / scripts.
ENV YOSYS_DATDIR=/usr/share/yosys

WORKDIR /work
ENTRYPOINT ["yosys"]
CMD ["-V"]
