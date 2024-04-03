type RecordingSetup = {
  streamId: string;
  recorder: MediaRecorder;
  stream: MediaStream;
  wsPort: number;
};

const recordings = new Map<string, RecordingSetup>();

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function startStreaming(port: number) {
  // @ts-expect-error getMediaStreamId returns a promise
  const streamId: string = await chrome.tabCapture.getMediaStreamId();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // @ts-expect-error mandatory field is not standard
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: {
      // @ts-expect-error mandatory field is not standard
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        minWidth: 1920,
        minHeight: 1080,
        maxWidth: 1920,
        maxHeight: 1080,
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));

  const recorder = new MediaRecorder(stream, {
    audioBitsPerSecond: 192000,
    videoBitsPerSecond: 8000000,
  });
  recorder.start(1500);

  const settings = getRecorderSettings();
  const wsUrl = new URL(`ws://localhost:${port || 8080}`);
  wsUrl.searchParams.set('video', settings.video);
  wsUrl.searchParams.set('audio', settings.audio);
  wsUrl.searchParams.set('streamId', streamId);

  const ws = new WebSocket(wsUrl);

  recorder.addEventListener('dataavailable', (e) => {
    if (e.data) {
      ws.send(e.data);
    }
  });

  recorder.addEventListener('stop', () => {
    ws.close();
  });

  recordings.set(streamId, {
    streamId,
    recorder,
    stream,
    wsPort: port,
  });

  return {
    streamId: streamId,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function stopStreaming(streamId: string) {
  const recordingSetup = recordings.get(streamId);
  if (recordingSetup === undefined) {
    throw new Error(`Setup ${streamId} not found`);
  }

  const {recorder, stream} = recordingSetup;
  stream.getTracks().forEach((track) => track.stop());
  recorder.stop();
  recordings.delete(streamId);
}

const getRecorderSettings = () => {
  if (MediaRecorder.isTypeSupported('video/mp4')) {
    return {
      format: 'mp4',
      video: 'h264',
      audio: 'aac',
    };
  } else {
    return {
      format: 'webm',
      audio: 'opus',
      video: MediaRecorder.isTypeSupported('video/webm;codecs=h264')
        ? 'h264'
        : 'vp8',
    };
  }
};
