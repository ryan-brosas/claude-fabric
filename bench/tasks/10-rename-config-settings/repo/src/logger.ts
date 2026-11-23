export type LogLevel = "debug" | "info" | "error";

export function createLogger(level: LogLevel = "info") {
  return (message: string): void => {
    if (level === "error") console.error(message);
    else console.log(message);
  };
}
