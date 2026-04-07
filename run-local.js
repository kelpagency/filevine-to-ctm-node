const fs = require("fs");
const path = require("path");

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing .env file at ${envPath}`);
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1);

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

async function main() {
  loadEnvFile(path.join(__dirname, ".env"));

  if (!process.env.LOG_PROGRESS_EVERY) {
    process.env.LOG_PROGRESS_EVERY = "10";
  }

  const startedAt = new Date();
  console.log(`[local] Starting sync at ${startedAt.toISOString()}`);
  console.log(
    `[local] LOG_PROGRESS_EVERY=${process.env.LOG_PROGRESS_EVERY} FILEVINE_ORG_ID=${process.env.FILEVINE_ORG_ID}`,
  );

  const { handler } = require("./netlify/functions/sync-ctm");
  const response = await handler();
  const finishedAt = new Date();

  console.log(`statusCode=${response.statusCode}`);
  console.log(response.body);
  console.log(
    `[local] Finished at ${finishedAt.toISOString()} (${Math.round(
      (finishedAt - startedAt) / 1000,
    )}s)`,
  );

  if (response.statusCode >= 400) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
