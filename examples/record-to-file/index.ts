import {setTimeout} from 'timers/promises';
import {
  launchBrowser,
  startSocketServer,
  startStreaming,
  streamToFile,
} from 'browser-to-stream';

(async function () {
  const browser = await launchBrowser();

  const stopServer = startSocketServer(8080, (stream, data) => {
    console.log('start streaming ', data.streamId);

    const ffmpeg = streamToFile(stream, __dirname + `/test.mp4`);

    ffmpeg.stderr.on('data', (data) => {
      console.log('FFmpeg STDERR:', data.toString());
    });
  });

  const page = await browser.newPage();
  await page.goto('https://www.youtube.com/embed/4S5KBlieT0I?autoplay=1');

  const {close} = await startStreaming(page);
  await setTimeout(4000);
  await close();
  await browser.close();
  stopServer();
})();
