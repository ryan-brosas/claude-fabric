export class HttpError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, payload: unknown) {
    super(`request failed with status ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.payload = payload;
  }
}
