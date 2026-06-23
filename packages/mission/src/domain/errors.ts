export class MissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissionError';
  }
}

export class InvalidStateError extends MissionError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateError';
  }
}

export class StaleRevisionError extends MissionError {
  constructor(id: string, expected: number, actual: number) {
    super(`Stale revision for mission ${id}: expected ${expected}, got ${actual}`);
    this.name = 'StaleRevisionError';
  }
}

export class InvalidHandoffError extends MissionError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidHandoffError';
  }
}

export class MissingMissionError extends MissionError {
  constructor(id: string) {
    super(`Mission not found: ${id}`);
    this.name = 'MissingMissionError';
  }
}

export class InvalidDefinitionError extends MissionError {
  constructor(errors: string[]) {
    super(`Invalid mission definition: ${errors.join('; ')}`);
    this.name = 'InvalidDefinitionError';
  }
}

export class MissionAlreadyExistsError extends MissionError {
  constructor(id: string) {
    super(`Mission already exists: ${id}`);
    this.name = 'MissionAlreadyExistsError';
  }
}
