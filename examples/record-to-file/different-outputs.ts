import {setTimeout} from 'timers/promises';
import {
  launchBrowser,
  startSocketServer,
  startStreaming,
  streamToFile,
} from 'browser-to-stream';

(async function () {
  const browser = await launchBrowser();

  let streamCount = 0;
  const stopServer = startSocketServer(8080, (stream, data) => {
    console.log('start streaming ', data.streamId);

    const ffmpeg = streamToFile(stream, __dirname + `/test-${streamCount}.mp4`);
    streamCount++;

    ffmpeg.stderr.on('data', (data) => {
      console.log('FFmpeg STDERR:', data.toString());
    });
  });

  const page1 = await browser.newPage();
  await page1.goto('https://www.youtube.com/embed/4S5KBlieT0I?autoplay=1');

  const {stop: stopStream1} = await startStreaming(page1);

  const page2 = await browser.newPage();

  await page2.goto('https://google.it');
  const {stop: stopStream2} = await startStreaming(page2, {
    recordingResizeFactor: 0.5,
  });

  await setTimeout(4000);
  await stopStream1();

  await setTimeout(4000);
  await stopStream2();

  await browser.close();
  stopServer();
})();
