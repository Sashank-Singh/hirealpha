# HireAlpha browser sandbox template.
#
# One Chromium, started fresh in every sandbox created from this template.
# The sandbox holds no secrets: the worker drives this browser over CDP and
# injects vault credentials only as keystrokes at fill time. Everything under
# /tmp (profile, cache, downloads) dies with the sandbox.
FROM e2bdev/base:latest

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium nodejs ca-certificates fonts-liberation fonts-noto-color-emoji \
    libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libasound2 \
  && rm -rf /var/lib/apt/lists/*

# Chromium needs a DevTools endpoint whose Host header a remote client can
# satisfy; the proxy on 9223 rewrites Host to 127.0.0.1 and supervises
# Chromium as its child (E2B reaps background jobs when the start command's
# foreground process is not the browser). SANDBOX_CDP_PORT in the worker
# defaults to 9223, so this must be the image's start command.
COPY cdp-proxy.mjs /opt/browser/cdp-proxy.mjs
CMD ["node", "/opt/browser/cdp-proxy.mjs"]

# Locale/timezone that match the sandbox's egress region. A page seeing UTC
# and a bare en-US locale from a US IP is a fingerprint mismatch; the worker
# also sets these per context (BROWSER_LOCALE / BROWSER_TIMEZONE).
ENV TZ=America/New_York \
    LANG=en_US.UTF-8 \
    LANGUAGE=en_US \
    CHROME_PROFILE=/tmp/chrome-profile
