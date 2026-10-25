FROM python:3.12-slim

# Set to "true" to include Calibre's converter, which enables the
# "Convert to EPUB" button for PDFs. It makes the image several times larger.
ARG INSTALL_CALIBRE=false
RUN if [ "$INSTALL_CALIBRE" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends calibre && rm -rf /var/lib/apt/lists/*; \
    fi

# bsdtar opens the .rar and .7z archives that books and comics often arrive in.
RUN apt-get update && apt-get install -y --no-install-recommends libarchive-tools && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY app/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY app/bookhub ./bookhub
COPY tagpacks ./tagpacks

ENV PYTHONUNBUFFERED=1 \
    BOOKHUB_PORT=8090 \
    TAGPACKS_DIR=/app/tagpacks
EXPOSE 8090
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/healthz', timeout=4).status == 200 else 1)"

CMD ["python", "-m", "bookhub"]
