import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import type {Page} from 'puppeteer';
import Fastify, {RequestGenericInterface} from 'fastify';
import {
  launchBrowser,
  startSocketServer,
  startStreaming,
  stopStreaming,
} from 'browser-to-stream';

interface StartRecordingRequest extends RequestGenericInterface {
  Querystring: {
    target: string;
  };
}

interface StopRecordingRequest extends RequestGenericInterface {
  Querystring: {
    streamId: string;
  };
}

async function startTestSourcePlayback(page: Page, target: string) {
  const url = new URL(target);
  if (url.hostname !== 'localhost' || url.pathname !== '/test-source') {
    return;
  }

  await page.waitForFunction('window.testSourceReady === true');
  const testSource = await page.waitForSelector('#sync-test');
  if (!testSource) {
    throw new Error('The audio/video sync test source was not found');
  }
  const boundingBox = await testSource.boundingBox();
  if (!boundingBox) {
    throw new Error('The audio/video sync test source is not visible');
  }

  await page.mouse.click(
    boundingBox.x + boundingBox.width / 2,
    boundingBox.y + boundingBox.height / 2
  );
  await page.waitForFunction('window.testSourcePlaybackStarted === true');
  await new Promise((resolve) => setTimeout(resolve, 500));
}

function recordWebCodecsStream(streamId: string, stream: Readable) {
  const outputFile = join(
    __dirname,
    `test-${encodeURIComponent(streamId)}.mp4`
  );
  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-y',
      '-f',
      'flv',
      '-i',
      'pipe:0',
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'copy',
      '-movflags',
      '+faststart',
      outputFile,
    ],
    {stdio: ['pipe', 'ignore', 'pipe']}
  );

  if (!ffmpeg.stdin) {
    throw new Error('Cannot create an FFmpeg input pipe for WebCodecs');
  }

  stream.pipe(ffmpeg.stdin);
  ffmpeg.stdin.on('error', (error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
      console.error('FFmpeg input error', error);
    }
  });
  console.log('recording WebCodecs output to', outputFile);

  ffmpeg.stderr?.on('data', (data) => {
    console.log('FFmpeg STDERR:', data.toString());
  });
  ffmpeg.on('close', (code, signal) => {
    console.log('FFmpeg child process closed, code', code, 'signal', signal);
  });
}

(async () => {
  const browser = await launchBrowser({
    viewport: {width: 1280, height: 720},
  });

  startSocketServer(8080, (stream, data) => {
    if (
      data.encoder !== 'webcodecs' ||
      data.track !== 'muxed' ||
      data.container !== 'flv'
    ) {
      stream.destroy(
        new Error('The HTTP example only accepts a muxed FLV WebCodecs stream')
      );
      return;
    }

    console.log('WebCodecs muxed stream connected', data.streamId);
    recordWebCodecsStream(data.streamId, stream);
  });

  const fastify = Fastify();

  fastify.get('/test-source', async function handler(_, reply) {
    reply.type('text/html').send(`<!doctype html>
<html>
  <body id="sync-test" style="margin:0;overflow:hidden;background:#111;color:#fff">
    <canvas id="canvas"></canvas>
    <script>
      const canvas = document.querySelector('#canvas');
      const context = canvas.getContext('2d');
      const audioContext = new AudioContext();
      let startTime = 0;
      let nextTick = 0;

      function resize() {
        canvas.width = innerWidth;
        canvas.height = innerHeight;
      }

      function scheduleTick(time) {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.frequency.value = 1000;
        gain.gain.setValueAtTime(0.08, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
        oscillator.connect(gain).connect(audioContext.destination);
        oscillator.start(time);
        oscillator.stop(time + 0.08);
      }

      function draw() {
        const elapsed = Math.max(0, audioContext.currentTime - startTime);
        while (nextTick < audioContext.currentTime + 2) {
          scheduleTick(nextTick);
          nextTick += 1;
        }

        const phase = elapsed % 1;
        const flash = phase < 0.1;
        context.fillStyle = flash ? '#ffffff' : '#111111';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = flash ? '#111111' : '#ffffff';
        context.font = 'bold 180px sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(String(Math.floor(elapsed)), canvas.width / 2, canvas.height / 2);
        context.font = '48px sans-serif';
        context.fillText('flash + tick ogni secondo', canvas.width / 2, canvas.height / 2 + 150);
        requestAnimationFrame(draw);
      }

      async function start() {
        if (window.testSourcePlaybackStarted) return;
        await audioContext.resume();
        startTime = audioContext.currentTime + 0.25;
        nextTick = startTime;
        window.testSourcePlaybackStarted = true;
        requestAnimationFrame(draw);
      }

      addEventListener('resize', resize);
      addEventListener('pointerdown', start, {once: true});
      resize();
      window.testSourceReady = true;
    </script>
  </body>
</html>`);
  });

  fastify.get<StartRecordingRequest>(
    '/start-recording',
    async function handler(request, reply) {
      const page = await browser.newPage();
      await page.goto(request.query.target, {waitUntil: 'domcontentloaded'});
      await startTestSourcePlayback(page, request.query.target);

      const {streamId, encoder, videoCodec, audioCodec} = await startStreaming(
        page,
        {encoder: 'webcodecs'}
      );

      reply.send({streamId, encoder, videoCodec, audioCodec});
    }
  );

  fastify.get<StopRecordingRequest>(
    '/stop-recording',
    async function handler(request, reply) {
      await stopStreaming(browser, request.query.streamId);
      reply.send();
    }
  );

  await fastify.listen({port: 3000});
  console.log('HTTP server listening on http://localhost:3000');
})();
