# Codespace Fast Download v3

Fast file browser/download server for GitHub Codespaces.

## Main improvements

- HTTP Range / `206 Partial Content`
- Node streaming with configurable `highWaterMark`
- Turbo downloader with parallel Range requests
- Adaptive connection tuning in `Auto` mode (starts conservatively, increases when throughput improves, backs off when it drops)
- Live throughput based on streamed bytes, not only completed chunks
- Smoothed speed + ETA + peak speed
- Chunk retry with exponential backoff
- Writes directly to disk through the File System Access API
- Safe path handling
- Optional server-side Range concurrency guard

## Run

```bash
npm start
```

Or:

```bash
node server.js
```

Default port is `8000`.

For Codespaces:

```bash
PORT=8000 node server.js
```

## Environment variables

- `DOWNLOAD_ROOT` — directory exposed by the server
- `PORT` — listening port, default `8000`
- `HOST` — bind address, default `0.0.0.0`
- `STREAM_CHUNK` — Node stream `highWaterMark`, default `4 MiB`
- `MAX_CONCURRENCY` — maximum adaptive Turbo connections, default `32`
- `RANGE_MAX_CONCURRENCY` — total active Range responses allowed by the server, default `MAX_CONCURRENCY * 2`
- `CORS=1` — enable CORS headers

Example:

```bash
MAX_CONCURRENCY=32 STREAM_CHUNK=8388608 node server.js
```

## Turbo settings

`Auto (recommended)` measures the current connection and server path and adjusts concurrency while downloading.

Manual modes are available for troubleshooting or unusual networks: 4, 8, 12, 16, 24, and 32 connections.

Chunk sizes: 4, 8, 16, 32, and 64 MiB.

Auto mode is not a guarantee of higher speed. The actual ceiling may be the Codespaces port-forwarding path, upstream bandwidth, browser, or storage.

## ETA

ETA is calculated from a smoothed recent throughput and remaining bytes, so it updates continuously and is more stable than a simple average while the connection ramps up.
