export interface SessionInstructions {
  persistentInstructions?: string;
}

export interface PreparedSessionInstructions extends SessionInstructions {
  persistentInstructionsFile?: string;
}
