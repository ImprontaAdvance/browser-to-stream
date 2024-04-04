import {Stream} from 'node:stream';
import {spawn} from 'node:child_process';

export function streamToFile(
  stream: Stream,
  file: string,
  ffmpegOptions: string[] = []
) {
  const options = ['-y', '-i', '-', ...ffmpegOptions, file];

  const ffmpeg = spawn('ffmpeg', options);

  // If FFmpeg stops for any reason, close the WebSocket connection.
  ffmpeg.on('close', (code, signal) => {
    console.log(
      'FFmpeg child process closed, code ' + code + ', signal ' + signal
    );
    ffmpeg.kill();
  });

  // Handle STDIN pipe errors by logging to the console.
  // These errors most commonly occur when FFmpeg closes and there is still
  // data to write.  If left unhandled, the server will crash.
  ffmpeg.stdin.on('error', (e) => {
    console.log('FFmpeg STDIN Error', e);
    ffmpeg.kill();
  });

  // // FFmpeg outputs all of its messages to STDERR.  Let's log them to the console.
  // ffmpeg.stderr.on('data', (data) => {
  //   console.log('FFmpeg STDERR:', data.toString());
  // });

  stream.pipe(ffmpeg.stdin);

  return ffmpeg;
}

export function streamToRtmp(stream: Stream, rtmp: string) {
  // https://scribbleghost.net/2018/10/26/recommended-encoding-settings-for-youtube-in-ffmpeg/
  // https://gist.github.com/tayvano/6e2d456a9897f55025e25035478a3a50
  const options = [
    '-y',
    '-i',
    '-',
    // video codec
    '-c:v',
    'libx264',
    // video codec
    // Set the encoding preset (cf. x264 —fullhelp) (default “medium”)
    '-preset',
    'veryfast',
    // Set the encoding preset (cf. x264 —fullhelp) (default “medium”)
    // Tune the encoding params
    '-tune',
    'zerolatency',
    // Tune the encoding params
    // frame rate 25
    '-r',
    '30',
    // frame rate 25
    // set GOP (should be double of fps)
    '-g',
    '60',
    // set GOP (should be double of fps)
    // minimum interval between IDR-frames (from INT_MIN to INT_MAX) (default 25)
    '-keyint_min',
    '25',
    // minimum interval between IDR-frames (from INT_MIN to INT_MAX) (default 25)
    // quality for constant quality mode
    '-crf',
    '25',
    // quality for constant quality mode
    // use 16:9 aspect ratio
    '-pix_fmt',
    'yuv420p',
    // use 16:9 aspect ratio
    // scene change threshold (from INT_MIN to INT_MAX) (default 0)
    '-sc_threshold',
    '0',
    // scene change threshold (from INT_MIN to INT_MAX) (default 0)
    // Set profile restrictions (cf. x264 —fullhelp)
    '-profile:v',
    'main',
    // Set profile restrictions (cf. x264 —fullhelp)
    // Specify level (as defined by Annex A)
    '-level',
    '3.1',
    // Specify level (as defined by Annex A)
    // audio codec
    '-c:a',
    'aac',
    // audio codec
    // channels set number of audio channels
    '-ac',
    '2',
    // channels set number of audio channels
    // set audio sampling rate (in Hz)
    '-ar',
    String(128000 / 4),
    // set audio sampling rate (in Hz)
    '-f',
    'flv',
    rtmp,
  ];

  const ffmpeg = spawn('ffmpeg', options);

  // If FFmpeg stops for any reason, close the WebSocket connection.
  ffmpeg.on('close', (code, signal) => {
    console.log(
      'FFmpeg child process closed, code ' + code + ', signal ' + signal
    );
    ffmpeg.kill();
  });

  // Handle STDIN pipe errors by logging to the console.
  // These errors most commonly occur when FFmpeg closes and there is still
  // data to write.  If left unhandled, the server will crash.
  ffmpeg.stdin.on('error', (e) => {
    console.log('FFmpeg STDIN Error', e);
    ffmpeg.kill();
  });

  // FFmpeg outputs all of its messages to STDERR.  Let's log them to the console.
  ffmpeg.stderr.on('data', (data) => {
    console.log('FFmpeg STDERR:', data.toString());
  });

  stream.pipe(ffmpeg.stdin);

  return ffmpeg;
}
