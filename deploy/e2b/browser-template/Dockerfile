# HireAlpha browser sandbox template.
#
# One Chromium, started fresh in every sandbox created from this template.
# The sandbox holds no secrets: the worker drives this browser over CDP and
# injects vault credentials only as keystrokes at fill time. Everything under
# /tmp (profile, cache, downloads) dies with the sandbox.
FROM e2bdev/base:latest

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium ca-certificates fonts-liberation fonts-noto-color-emoji \
    libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libasound2 \
  && rm -rf /var/lib/apt/lists/*

# Chromium with CDP reachable from the worker over the sandbox's public host
# routing. The profile lives in /tmp so no cookie, cache, or storage survives
# the sandbox even if destruction were somehow skipped.
ENV CHROME_PROFILE=/tmp/chrome-profile
CMD ["chromium", \
  "--headless=new", \
  "--no-sandbox", \
  "--disable-setuid-sandbox", \
  "--disable-dev-shm-usage", \
  "--remote-debugging-address=0.0.0.0", \
  "--remote-debugging-port=9222", \
  "--user-data-dir=/tmp/chrome-profile", \
  "--window-size=1280,800", \
  "about:blank"]
