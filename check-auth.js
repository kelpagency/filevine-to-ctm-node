const fs = require("fs");
const path = require("path");

const FILEVINE_TOKEN_URL = "https://identity.filevine.com/connect/token";
const FILEVINE_USER_ORGS_URL =
  "https://api.filevineapp.com/fv-app/v2/utils/GetUserOrgsWithToken";

function getDefaultFilevineScope() {
  return [
    "fv.api.gateway.access",
    "tenant",
    "filevine.v2.api.*",
    "email",
    "openid",
    "fv.auth.tenant.read",
  ].join(" ");
}

function getDefaultFilevineBaseUrl() {
  return ["https://api.filevineapp.com", "fv-app", "v2"].join("/");
}

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

function getEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function getFilevineToken() {
  const payload = new URLSearchParams({
    client_id: getEnv("FILEVINE_CLIENT_ID"),
    client_secret: getEnv("FILEVINE_CLIENT_SECRET"),
    grant_type: "personal_access_token",
    scope: process.env.FILEVINE_PAT_SCOPE || getDefaultFilevineScope(),
    token: getEnv("FILEVINE_PAT_TOKEN"),
  });

  const response = await fetch(FILEVINE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: payload,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Filevine auth failed (${response.status}): ${text}`);
  }

  const auth = await response.json();
  if (!auth.access_token) {
    throw new Error("Filevine auth response did not include access_token");
  }

  return auth.access_token;
}

async function getFilevineContext(accessToken) {
  const response = await fetch(FILEVINE_USER_ORGS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: "{}",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Filevine context lookup failed (${response.status}): ${text}`);
  }

  const context = await response.json();
  const resolvedUserId = context.user?.userId?.native ?? context.user?.userId;
  const orgs = Array.isArray(context.orgs) ? context.orgs : [];
  const requestedOrgId = process.env.FILEVINE_ORG_ID;
  const resolvedOrg = requestedOrgId
    ? orgs.find((org) => String(org.orgId) === String(requestedOrgId))
    : orgs[0];

  if (!resolvedUserId) {
    throw new Error("Filevine context lookup did not return a user ID");
  }

  if (!resolvedOrg?.orgId) {
    throw new Error(
      requestedOrgId
        ? `Filevine context lookup did not return org ${requestedOrgId}`
        : "Filevine context lookup did not return any orgs",
    );
  }

  return {
    userId: String(resolvedUserId),
    orgId: String(resolvedOrg.orgId),
    orgName: resolvedOrg.name || null,
  };
}

async function checkFilevineApi(accessToken, context) {
  const filevineBaseUrl =
    process.env.FILEVINE_BASE_URL || getDefaultFilevineBaseUrl();

  const response = await fetch(`${filevineBaseUrl}/Projects/?limit=1`, {
    headers: {
      "x-fv-orgid": context.orgId,
      "x-fv-userid": context.userId,
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Filevine API check failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function checkCtmApi() {
  const accountId = getEnv("CTM_ACCOUNT_ID");
  const listId = getEnv("CTM_CONTACT_LIST_ID");
  const url = `https://api.calltrackingmetrics.com/api/v1/accounts/${accountId}/lists/${listId}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${getEnv("CTM_BASIC_AUTH")}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`CTM auth check failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function main() {
  loadEnvFile(path.join(__dirname, ".env"));

  const result = {
    ok: true,
    filevine: { ok: false },
    ctm: { ok: false },
  };

  try {
    const accessToken = await getFilevineToken();
    const context = await getFilevineContext(accessToken);
    const projectPage = await checkFilevineApi(accessToken, context);
    result.filevine = {
      ok: true,
      userId: context.userId,
      orgId: context.orgId,
      orgName: context.orgName,
      projectCountOnFirstPage: Array.isArray(projectPage.items)
        ? projectPage.items.length
        : null,
    };
  } catch (error) {
    result.ok = false;
    result.filevine = { ok: false, error: error.message };
  }

  try {
    const ctmResponse = await checkCtmApi();
    result.ctm = {
      ok: true,
      listId: ctmResponse.id || ctmResponse.list_id || null,
      name: ctmResponse.name || null,
    };
  } catch (error) {
    result.ok = false;
    result.ctm = { ok: false, error: error.message };
  }

  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
