import {Stream} from 'node:stream';
import {spawn} from 'node:child_process';

export interface StreamToRtmpOptions {
  audioBitrate?: string;
  audioSampleRate?: number;
  audioChannels?: number;
}

/**
 * Remuxes the muxed FLV stream produced by `encoder: 'webcodecs'` to an
 * RTMP(S) endpoint without decoding or encoding H.264/AAC.
 */
export function streamFlvToRtmp(stream: Stream, rtmp: string) {
  const options = [
    '-y',
    '-f',
    'flv',
    '-i',
    '-',
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-c:v',
    'copy',
    '-c:a',
    'copy',
    '-flvflags',
    'no_duration_filesize',
    '-f',
    'flv',
    rtmp,
  ];

  const ffmpeg = spawn('ffmpeg', options);
  pipeStreamToFfmpeg(stream, ffmpeg);
  return ffmpeg;
}

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

  pipeStreamToFfmpeg(stream, ffmpeg);

  return ffmpeg;
}

export function streamToRtmp(
  stream: Stream,
  rtmp: string,
  {
    audioBitrate = '192k',
    audioSampleRate = 48000,
    audioChannels = 2,
  }: StreamToRtmpOptions = {}
) {
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
    '25',
    // frame rate 25
    // set GOP (should be double of fps)
    '-g',
    '50',
    // set GOP (should be double of fps)
    // minimum interval between IDR-frames (from INT_MIN to INT_MAX) (default 25)
    // '-keyint_min',
    // '25',
    // minimum interval between IDR-frames (from INT_MIN to INT_MAX) (default 25)
    // quality for constant quality mode
    // '-crf',
    // '25',
    // quality for constant quality mode
    // use 16:9 aspect ratio
    '-pix_fmt',
    'yuv420p',
    // use 16:9 aspect ratio
    // scene change threshold (from INT_MIN to INT_MAX) (default 0)
    // '-sc_threshold',
    // '0',
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
    // set audio bitrate
    '-b:a',
    audioBitrate,
    // set audio bitrate
    // set audio sampling rate (in Hz)
    '-ar',
    String(audioSampleRate),
    // set audio sampling rate (in Hz)
    // channels set number of audio channels
    '-ac',
    String(audioChannels),
    // channels set number of audio channels
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

  // FFmpeg outputs all of its messages to STDERR.  Let's log them to the console.
  ffmpeg.stderr.on('data', (data) => {
    console.log('FFmpeg STDERR:', data.toString());
  });

  pipeStreamToFfmpeg(stream, ffmpeg);

  return ffmpeg;
}

function pipeStreamToFfmpeg(stream: Stream, ffmpeg: ReturnType<typeof spawn>) {
  const stdin = ffmpeg.stdin;
  if (!stdin) {
    throw new Error('Cannot create an FFmpeg input pipe');
  }

  stdin.on('error', (error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
      console.log('FFmpeg STDIN Error', error);
    }
  });
  stream.pipe(stdin);
}
