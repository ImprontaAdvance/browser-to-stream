import Fastify, {RequestGenericInterface} from 'fastify';
import {
  launchBrowser,
  startSocketServer,
  startStreaming,
  stopStreaming,
  streamToFile,
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
(async () => {
  const browser = await launchBrowser();

  startSocketServer(8080, (stream, data) => {
    console.log('start streaming ', data.streamId);

    streamToFile(stream, __dirname + `/test-${data.streamId}.mp4`);
  });

  const fastify = Fastify();

  fastify.get<StartRecordingRequest>(
    '/start-recording',
    async function handler(request, reply) {
      const page = await browser.newPage();
      await page.goto(request.query.target);

      const {streamId} = await startStreaming(page);

      reply.send({streamId});
    }
  );

  fastify.get<StopRecordingRequest>(
    '/stop-recording',
    async function handler(request, reply) {
      stopStreaming(browser, request.query.streamId);
      reply.send();
    }
  );

  await fastify.listen({port: 3000});
})();
