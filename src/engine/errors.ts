/** Thrown when a mutation would violate the schema or a graph invariant. */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Thrown when a privileged op (delete) is attempted without explicit confirmation. */
export class ConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsentError";
  }
}

/** Thrown when a referenced entity / stream does not exist. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
