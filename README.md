# browser-to-stream

A wrapper around puppetteer to record a browser tab into a stream.


## How it works

This module uses [puppeteer](https://github.com/puppeteer/puppeteer) initialized with a chrome extension. The extension records the opened page using [MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/) API and it sends back the video's chunks via websocket.

## Installation
Install `browser-to-stream` with your preferred package manager for node.js

## Usage

```typescript
import {
  launchBrowser,
  startSocketServer,
  startStreaming,
  streamToFile,
} from 'browser-to-stream';

// Launch headless browser
const browser = await launchBrowser();

// Setup websocket server
const stopServer = startSocketServer(8080, (stream, data) => {
  // stream to file once received stream
  streamToFile(stream, __dirname + `/test.mp4`);
});

// prepare the page
const page = await browser.newPage();
await page.goto('https://www.youtube.com/embed/4S5KBlieT0I?autoplay=1');

// start streaming the page
const {stop} = await startStreaming(page);

// stop the streaming
await stop();

// cleanup browser and server
await browser.close();
stopServer();
```

## Streaming size

The streaming output will be at the same size of the browser's viewport (1920x1080 by default), so you can control the output size by specifying it

```typescript
const browser = await launchBrowser({
  viewport: {
    width: 1280,
    height: 720,
  }
});
```

To start the streaming at a different size from the browser's viewport, specify the `recordingResizeFactor` on `startStreaming` (default to `1`)
```typescript
const {stop} = await startStreaming(page, {
  recordingResizeFactor: 0.5
});
```

Check more [examples](./examples/).


## How to use in docker

Starting point

```Dockerfile
FROM node:20-slim

RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Create a user with name 'app' and group that will be used to run the app
RUN groupadd -r app && useradd -rm -g app -G audio,video app

RUN apt-get update \
    && apt-get install -y ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/app
USER app
# We don't need the standalone Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD true

# Copy code into /home/app
# install dependencies
# and run the script
```