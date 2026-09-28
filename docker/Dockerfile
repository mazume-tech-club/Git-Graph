# Git-Graph の開発用イメージ。Rust（Tauri バックエンド）と Node（フロントエンド）を
# まとめて入れ、ホスト側にツールチェーンを入れなくてもビルドできるようにする。
FROM rust:1-bookworm

ARG NODE_MAJOR=22

# Tauri v2 が Linux でビルドするために必要なシステムライブラリ
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      file \
      git \
      libayatana-appindicator3-dev \
      librsvg2-dev \
      libssl-dev \
      libwebkit2gtk-4.1-dev \
      libxdo-dev \
      pkg-config \
      wget \
    && rm -rf /var/lib/apt/lists/*

# Node.js（NodeSource）
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# lint / フォーマット確認用
RUN rustup component add clippy rustfmt

# tauri CLI は npm の @tauri-apps/cli（devDependency）が持っているので、
# ここで cargo install はしない（イメージのビルドが数分短くなる）。

WORKDIR /app
