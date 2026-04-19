// fetchEnv is used when you need to get a required environment variable.
// If it is not found, or the value is falsey, it will throw an error.
export function fetchEnv(envName: string): string {
  let value = process.env[envName];

  if (Object.prototype.hasOwnProperty.call(process.env, envName) && value) {
    return value;
  } else {
    throw new Error(`environment variable '${envName}' not found`);
  }
}

// fetchEnvironment returns NODE_ENV, defaulting to 'development' when unset
// or blank.
export function fetchEnvironment(): string {
  return process.env.NODE_ENV?.trim() || 'development';
}
