export interface ArtifactNamingConfig {
  artifactPrefix?: string;
}

export function normalizeArtifactPrefix(prefix: string | undefined, fallback = 'agent'): string {
  const value = (prefix ?? fallback).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return value.length > 0 ? value : fallback;
}
