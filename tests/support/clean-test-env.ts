const deploymentOnlyVariables = [
  "TAGENT_CORS_ALLOWED_ORIGINS",
  "TAGENT_SERVICE_CREDENTIALS",
] as const;

for (const name of deploymentOnlyVariables) delete process.env[name];
