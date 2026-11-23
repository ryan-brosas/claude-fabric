export interface LogSinkOptions {
  write?: (line: string) => void;
}

export function logSink(options: LogSinkOptions = {}) {
  const write = options.write ?? ((line: string) => console.log(line));
  return (payload: unknown, meta: { topic: string; pattern: string }): void => {
    write(JSON.stringify({ topic: meta.topic, pattern: meta.pattern, payload }));
  };
}
