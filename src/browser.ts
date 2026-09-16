import puppeteer from 'puppeteer';
import type {Browser, Page} from 'puppeteer';
import {join} from 'node:path';
import {existsSync} from 'node:fs';

const extensionPath = join(__dirname, '/chrome-extension');
const extensionId = 'hgidmgkiljoiikiahkhoggnfaiipcgen';
const extensionPagesWithForwardedErrors = new WeakSet<Page>();

export type LaunchBrowserOptions = {
  headless?: boolean;
  viewport?: {width: number; height: number};
};

type StreamID = string;

export type StreamingEncoder = 'media-recorder' | 'webcodecs';

export type StartStreamingOptions = {
  wsPort?: number;
  recordingResizeFactor?: number;
  encoder?: StreamingEncoder;
};

export type StartStreamingResult = {
  streamId: string;
  encoder: StreamingEncoder;
  videoCodec?: string;
  audioCodec?: string;
  stop: () => Promise<void>;
};

export async function launchBrowser({
  viewport = {width: 1920, height: 1080},
  headless = true,
}: LaunchBrowserOptions = {}): Promise<Browser> {
  // Launch the browser
  const browser = await puppeteer.launch({
    headless,
    executablePath: findBrowserExecutablePath(),
    defaultViewport: viewport,
    ignoreDefaultArgs: ['--mute-audio', '--disable-extensions'],
    args: [
      '--app',
      '--no-sandbox',
      '--enable-gpu',
      '--no-first-run',
      `--window-size=${viewport.width},${viewport.height}`,
      '--disable-dev-shm-usage',
      '--user-data-dir=/tmp/chrome' + Date.now(),
      `--load-extension=${extensionPath}`,
      `--disable-extensions-except=${extensionPath}`,
      `--allowlisted-extension-id=${extensionId}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  // Wait extension page is loaded
  await getExtensionPage(browser);

  return browser;
}

export async function startStreaming(
  page: Page,
  {
    wsPort = 8080,
    recordingResizeFactor = 1,
    encoder = 'media-recorder',
  }: StartStreamingOptions = {}
): Promise<StartStreamingResult> {
  const browser = page.browser();

  const extensionPage = await getExtensionPage(browser);

  await page.bringToFront();

  const res = await extensionPage.evaluate(
    (wsPort, recordingResizeFactor, encoder) => {
      return window.startStreaming({wsPort, recordingResizeFactor, encoder});
    },
    wsPort,
    recordingResizeFactor,
    encoder
  );

  return {
    streamId: res.streamId,
    encoder: res.encoder,
    videoCodec: res.videoCodec,
    audioCodec: res.audioCodec,
    stop: stopStreaming.bind(null, browser, res.streamId),
  };
}

export async function stopStreaming(
  browser: Browser,
  streamId: StreamID
): Promise<void> {
  const extensionPage = await getExtensionPage(browser);

  await extensionPage.evaluate((streamId) => {
    return window.stopStreaming(streamId);
  }, streamId);
}

async function getExtensionPage(browser: Browser) {
  const extensionTarget = await browser.waitForTarget((target) => {
    return target.type() === 'page' && target.url().includes('options.html');
  });

  if (!extensionTarget) {
    throw new Error('cannot load extension');
  }

  const videoCaptureExtension = await extensionTarget.page();
  if (!videoCaptureExtension) {
    throw new Error('cannot get page of extension');
  }

  if (!extensionPagesWithForwardedErrors.has(videoCaptureExtension)) {
    extensionPagesWithForwardedErrors.add(videoCaptureExtension);
    videoCaptureExtension.on('console', (message) => {
      if (message.type() === 'error') {
        console.error('[Chrome extension]', message.text());
      }
    });
  }

  return videoCaptureExtension;
}

function findBrowserExecutablePath(): string {
  const executablePath = puppeteer.executablePath();
  if (existsSync(executablePath)) {
    return executablePath;
  }

  if (process.env.CHROME_BIN) {
    return process.env.CHROME_BIN;
  }

  throw new Error(
    `Chrome for Testing was not found at ${executablePath}. ` +
      'Install Puppeteer browser dependencies or set CHROME_BIN to a compatible Chrome for Testing or Chromium executable.'
  );
}
