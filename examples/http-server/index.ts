import {Readable} from 'node:stream';
import Fastify, {RequestGenericInterface} from 'fastify';
import {
  launchBrowser,
  startSocketServer,
  startStreaming,
  stopStreaming,
  streamMatroskaToRtmp,
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

const activeRtmpsStreams = new Map<string, Promise<void>>();

function streamWebCodecsToRtmps(
  streamId: string,
  stream: Readable,
  rtmpsUrl: string
) {
  const ffmpeg = streamMatroskaToRtmp(stream, rtmpsUrl);
  console.log('streaming WebCodecs output to Vimeo via RTMPS (H.264 copy)');

  ffmpeg.stderr?.on('data', (data) => {
    console.log('FFmpeg STDERR:', redactRtmpsUrls(data.toString()));
  });
  const done = new Promise<void>((resolve) => {
    ffmpeg.on('close', (code, signal) => {
      console.log('FFmpeg child process closed, code', code, 'signal', signal);
      activeRtmpsStreams.delete(streamId);
      resolve();
    });
  });
  activeRtmpsStreams.set(streamId, done);
}

function getVimeoRtmpsUrl() {
  const streamUrl = process.env.VIMEO_RTMPS_URL;
  const streamKey = process.env.VIMEO_STREAM_KEY;
  if (!streamUrl || !streamKey) {
    throw new Error(
      'Set VIMEO_RTMPS_URL and VIMEO_STREAM_KEY before starting this example'
    );
  }

  let endpoint: URL;
  try {
    endpoint = new URL(streamUrl);
  } catch {
    throw new Error('VIMEO_RTMPS_URL must be a valid RTMPS URL');
  }
  if (endpoint.protocol !== 'rtmps:' && endpoint.protocol !== 'rtmp:') {
    throw new Error('VIMEO_RTMPS_URL must use the rtmp: or rtmps: protocol');
  }

  // Vimeo RTMPS ingest listens on 443. Vimeo normally includes it in the URL,
  // but accepting an omitted port makes the local example less error-prone.
  if (endpoint.protocol === 'rtmps:' && !endpoint.port) {
    endpoint.port = '443';
  }

  return `${endpoint.toString().replace(/\/+$/, '')}/${streamKey}`;
}

function redactRtmpsUrls(message: string) {
  return message.replace(/rtmps?:\/\/[^\s']+/g, '[redacted RTMPS URL]');
}

(async () => {
  const rtmpsUrl = getVimeoRtmpsUrl();
  const browser = await launchBrowser({
    viewport: {width: 1280, height: 720},
  });

  startSocketServer(8080, (stream, data) => {
    if (
      data.encoder !== 'webcodecs' ||
      data.track !== 'muxed' ||
      data.container !== 'matroska'
    ) {
      stream.destroy(
        new Error(
          'The HTTP example only accepts a muxed Matroska WebCodecs stream'
        )
      );
      return;
    }

    console.log('WebCodecs muxed stream connected', data.streamId);
    streamWebCodecsToRtmps(data.streamId, stream, rtmpsUrl);
  });

  const fastify = Fastify();

  fastify.get<StartRecordingRequest>(
    '/start-recording',
    async function handler(request, reply) {
      const page = await browser.newPage();
      await page.goto(request.query.target, {waitUntil: 'domcontentloaded'});

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
      const rtmpsStreamDone = activeRtmpsStreams.get(request.query.streamId);
      await stopStreaming(browser, request.query.streamId);
      await rtmpsStreamDone;
      reply.send();
    }
  );

  await fastify.listen({port: 3000});
  console.log('HTTP server listening on http://localhost:3000');
})();
