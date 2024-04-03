import puppeteer from 'puppeteer';
import type {Browser, Page} from 'puppeteer';
import {join} from 'node:path';
import {existsSync} from 'node:fs';

const extensionPath = join(__dirname, '/chrome-extension');
const extensionId = 'hgidmgkiljoiikiahkhoggnfaiipcgen';

type LaunchBrowserOptions = {
  headless?: boolean;
  viewport?: {width: number; height: number};
};

type StreamID = string;

type StartStreamingOptions = {
  port?: number;
  width?: number;
  height?: number;
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
    ignoreDefaultArgs: ['--mute-audio'],
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
    port = 8080,
    width = undefined,
    height = undefined,
  }: StartStreamingOptions = {}
) {
  const browser = page.browser();

  const extensionPage = await getExtensionPage(browser);

  await page.bringToFront();

  const res = await extensionPage.evaluate(
    (port, width, height) => {
      return window.startStreaming(port, width, height);
    },
    port,
    width,
    height
  );

  return {
    streamId: res.streamId,
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

  return videoCaptureExtension;
}

function findBrowserExecutablePath(): string {
  if (process.env.CHROME_BIN) {
    return process.env.CHROME_BIN;
  }

  const paths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ];

  for (const path of paths) {
    if (existsSync(path)) {
      return path;
    }
  }

  throw new Error('chrome executable path not found');
}
