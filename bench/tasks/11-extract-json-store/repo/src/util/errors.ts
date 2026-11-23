export class NotFoundError extends Error {
  readonly code = "not_found";

  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends Error {
  readonly code = "invalid";

  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
