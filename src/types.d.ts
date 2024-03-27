interface Window {
  startStreaming: (port: number) => Promise<{streamId: string}>;
  stopStreaming: (streamId: string) => void;
}
