export class DevtaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevtaskError";
  }
}
