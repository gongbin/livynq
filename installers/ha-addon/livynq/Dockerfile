ARG BUILD_FROM
FROM ${BUILD_FROM}

ARG BUILD_ARCH
ARG LIVYNQ_VERSION=v0.3.0

# The single-file Livynq binary (Node runtime + hub + web UI) from GitHub Releases.
RUN set -eux; \
    case "${BUILD_ARCH}" in amd64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo "unsupported ${BUILD_ARCH}"; exit 1 ;; esac; \
    curl -fsSL "https://github.com/gongbin/livynq/releases/download/${LIVYNQ_VERSION}/livynq-linux-${arch}.gz" | gunzip > /usr/local/bin/livynq; \
    chmod 755 /usr/local/bin/livynq; \
    /usr/local/bin/livynq --version

COPY run.sh /run.sh
RUN chmod 755 /run.sh
CMD ["/run.sh"]
