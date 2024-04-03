type RecordingSetup = {
  streamId: string;
  recorder: MediaRecorder;
  stream: MediaStream;
  wsPort: number;
};

const recordings = new Map<string, RecordingSetup>();

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function startStreaming(port: number, recordingResizeFactor: number = 1) {
  // @ts-expect-error getMediaStreamId returns a promise
  const streamId: string = await chrome.tabCapture.getMediaStreamId();

  const [tab] = await chrome.tabs.query({active: true});
  const [currentWindow] = await chrome.scripting.executeScript({
    // @ts-expect-error tab id is not undefined
    target: {tabId: tab.id},
    func: () => ({width: window.innerWidth, height: window.innerHeight}),
  });

  const streamWidth =
    (currentWindow.result?.width || 1920) * recordingResizeFactor;
  const streamHeight =
    (currentWindow.result?.height || 1080) * recordingResizeFactor;

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
        minWidth: streamWidth,
        minHeight: streamHeight,
        maxWidth: streamWidth,
        maxHeight: streamHeight,
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
