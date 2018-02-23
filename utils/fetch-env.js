// fetchEnv is used when you need to get a required environment variable.
// If it is not found, or the value is falsey, it will throw an error.
let fetchEnv = function(envName) {
  let value = process.env[envName];

  if (process.env.hasOwnProperty(envName) && value) {
    return value;
  } else {
    throw new Error(`environment variable '${envName}' not found`);
  }
};

module.exports = fetchEnv;
