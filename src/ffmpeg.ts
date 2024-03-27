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
  const options = [
    '-y',
    '-i',
    '-',
    // video codec
    '-c:v',
    'libx264',
    // video codec
    '-preset',
    'veryfast',
    '-tune',
    'zerolatency',
    // frame rate 25
    '-r',
    '30',
    // frame rate 25
    // video size
    '-s',
    '1920x1080',
    // video size
    // set GOP (should be half of fps)
    '-g',
    '60',
    // set GOP (should be half of fps)
    '-keyint_min',
    '25',
    '-crf',
    '25',
    // use 16:9 aspect ratio
    '-pix_fmt',
    'yuv420p',
    // use 16:9 aspect ratio
    '-sc_threshold',
    '0',
    '-profile:v',
    'main',
    '-level',
    '3.1',
    '-c:a',
    'aac',
    // audio bitrate
    '-b:a',
    '44k',
    // audio bitrate
    // audio stereo
    '-ac',
    '2',
    // audio stereo
    // bitrate
    '-b:v',
    '8000K',
    '-maxrate',
    '9000K',
    '-bufsize',
    '4000K',
    // bitrate
    '-ar',
    String(128000 / 4),
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
