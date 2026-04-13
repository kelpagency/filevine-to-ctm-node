const FILEVINE_TOKEN_URL = "https://identity.filevine.com/connect/token";

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

function getFilevineUserOrgsUrl() {
  return `${getDefaultFilevineBaseUrl()}/utils/GetUserOrgsWithToken`;
}

const tokenCache = {
  token: null,
  expiresAt: 0,
  context: null,
};

function getEnv(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPositiveIntegerEnv(name, fallback, maxValue = Number.POSITIVE_INFINITY) {
  const rawValue = process.env[name];
  const value = rawValue === undefined || rawValue === "" ? fallback : Number(rawValue);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }

  return Math.min(value, maxValue);
}

function getOptionalPositiveIntegerEnv(name) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === "") {
    return null;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }

  return value;
}

function getRecentActivityCutoff() {
  const rawHours = process.env.FILEVINE_LOOKBACK_HOURS;
  if (rawHours === undefined || rawHours === "") {
    return null;
  }

  const hours = Number(rawHours);
  if (!Number.isInteger(hours) || hours <= 0) {
    throw new Error("FILEVINE_LOOKBACK_HOURS must be a positive integer");
  }

  return Date.now() - hours * 60 * 60 * 1000;
}

async function mapWithConcurrency(items, concurrency, iterator) {
  const workerCount = Math.min(concurrency, items.length);
  let index = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await iterator(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
}

async function requestWithRetry(method, url, options = {}) {
  const {
    maxRetries = 3,
    backoffMs = 500,
    timeoutMs = 15000,
    headers,
    body,
  } = options;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return response;
    } catch (error) {
      clearTimeout(timeout);
      const isLastAttempt = attempt === maxRetries - 1;
      if (isLastAttempt) {
        throw error;
      }
      await sleep(backoffMs * 2 ** attempt);
    }
  }

  throw new Error(`Failed request after retries: ${method} ${url}`);
}

function cleanPhoneNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) {
    return null;
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  return digits.startsWith("+") ? digits : `+${digits}`;
}

function getClientId(caseItem) {
  if (!caseItem) {
    return null;
  }
  const { clientId } = caseItem;
  if (clientId && typeof clientId === "object") {
    return clientId.native;
  }
  return clientId;
}

async function getFilevineHeaders() {
  const now = Date.now();
  if (tokenCache.token && tokenCache.context && now < tokenCache.expiresAt) {
    return {
      "x-fv-orgid": tokenCache.context.orgId,
      "x-fv-userid": tokenCache.context.userId,
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${tokenCache.token}`,
    };
  }

  const payload = new URLSearchParams({
    client_id: getEnv("FILEVINE_CLIENT_ID"),
    client_secret: getEnv("FILEVINE_CLIENT_SECRET"),
    grant_type: "personal_access_token",
    scope: process.env.FILEVINE_PAT_SCOPE || getDefaultFilevineScope(),
    token: getEnv("FILEVINE_PAT_TOKEN"),
  });

  const response = await requestWithRetry("POST", FILEVINE_TOKEN_URL, {
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

  const contextResponse = await requestWithRetry(
    "POST",
    getFilevineUserOrgsUrl(),
    {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${auth.access_token}`,
    },
    body: "{}",
    },
  );

  if (!contextResponse.ok) {
    const text = await contextResponse.text();
    throw new Error(
      `Filevine context lookup failed (${contextResponse.status}): ${text}`,
    );
  }

  const context = await contextResponse.json();
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

  tokenCache.token = auth.access_token;
  tokenCache.expiresAt = now + 10 * 60 * 1000;
  tokenCache.context = {
    userId: String(resolvedUserId),
    orgId: String(resolvedOrg.orgId),
  };

  return {
    "x-fv-orgid": tokenCache.context.orgId,
    "x-fv-userid": tokenCache.context.userId,
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${tokenCache.token}`,
  };
}

async function upsertCtmContact({ caseItem, client, phone }) {
  const accountId = getEnv("CTM_ACCOUNT_ID");
  const listId = getEnv("CTM_CONTACT_LIST_ID");
  const ctmBaseUrl = `https://api.calltrackingmetrics.com/api/v1/accounts/${accountId}/lists/${listId}`;

  const ctmHeaders = {
    Authorization: `Basic ${getEnv("CTM_BASIC_AUTH")}`,
    "Content-Type": "application/json",
  };

  await requestWithRetry("DELETE", `${ctmBaseUrl}/remove_contacts`, {
    headers: ctmHeaders,
    body: JSON.stringify({ contacts_list: [phone] }),
  });

  const payload = {
    contact: {
      number: phone,
      first_name: client.firstName || null,
      last_name: client.lastName || null,
      custom_primary: caseItem.firstPrimaryName || null,
      custom_phase: caseItem.phaseName || null,
      custom_project_link: caseItem.projectUrl || null,
      custom_project_id: caseItem.projectId?.native || caseItem.projectId || null,
      custom_lead_docket_or_filevine: "filevine",
    },
  };

  const response = await requestWithRetry("POST", `${ctmBaseUrl}/add_contact`, {
    headers: ctmHeaders,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to add contact (${response.status}): ${text}`);
  }
}

exports.handler = async () => {
  const stats = {
    totalProjects: 0,
    projectsProcessed: 0,
    projectsSkippedNoPhone: 0,
    projectsSkippedClientFetchFailed: 0,
    contactsUpdated: 0,
    contactsFailedToAdd: 0,
    unexpectedErrors: 0,
  };

  const batchSize = getPositiveIntegerEnv("LOG_PROGRESS_EVERY", 100);
  const projectPageLimit = getPositiveIntegerEnv(
    "FILEVINE_PROJECT_PAGE_LIMIT",
    1000,
    1000,
  );
  const projectConcurrency = getPositiveIntegerEnv(
    "FILEVINE_PROJECT_CONCURRENCY",
    5,
    25,
  );
  const maxProjectsPerRun =
    getOptionalPositiveIntegerEnv("FILEVINE_MAX_PROJECTS_PER_RUN") ??
    Number.POSITIVE_INFINITY;
  const recentActivityCutoff = getRecentActivityCutoff();
  const filevineBaseUrl =
    process.env.FILEVINE_BASE_URL || getDefaultFilevineBaseUrl();

  try {
    console.log("sync-ctm started", {
      batchSize,
      projectPageLimit,
      projectConcurrency,
      maxProjectsPerRun,
      lookbackHours: process.env.FILEVINE_LOOKBACK_HOURS || null,
      filevineBaseUrl,
      orgId: process.env.FILEVINE_ORG_ID || null,
    });

    let nextUrl = `${filevineBaseUrl}/Projects/?sortBy=LastActivity&limit=${projectPageLimit}`;
    let shouldStopAfterCurrentPage = false;

    while (nextUrl && !shouldStopAfterCurrentPage) {
      console.log("Fetching projects page", { nextUrl });
      const headers = await getFilevineHeaders();
      const projectResponse = await requestWithRetry("GET", nextUrl, { headers });
      if (!projectResponse.ok) {
        const text = await projectResponse.text();
        throw new Error(
          `Failed to fetch projects (${projectResponse.status}): ${text}`,
        );
      }

      const projectPage = await projectResponse.json();
      const projectsToProcess = [];

      for (const caseItem of projectPage.items || []) {
        if (stats.totalProjects >= maxProjectsPerRun) {
          shouldStopAfterCurrentPage = true;
          break;
        }

        if (
          recentActivityCutoff &&
          caseItem.lastActivity &&
          Date.parse(caseItem.lastActivity) < recentActivityCutoff
        ) {
          shouldStopAfterCurrentPage = true;
          break;
        }

        stats.totalProjects += 1;
        projectsToProcess.push(caseItem);

        if (batchSize > 0 && stats.totalProjects % batchSize === 0) {
          console.log("Progress", stats);
        }
      }

      await mapWithConcurrency(projectsToProcess, projectConcurrency, async (caseItem) => {
        const clientId = getClientId(caseItem);
        if (!clientId) {
          stats.projectsSkippedClientFetchFailed += 1;
          return;
        }

        let client;
        try {
          const contactResponse = await requestWithRetry(
            "GET",
            `${filevineBaseUrl}/Contacts/${clientId}`,
            { headers: await getFilevineHeaders() },
          );
          if (!contactResponse.ok) {
            stats.projectsSkippedClientFetchFailed += 1;
            return;
          }
          client = await contactResponse.json();
        } catch (error) {
          stats.projectsSkippedClientFetchFailed += 1;
          return;
        }

        const phones = Array.isArray(client.phones) ? client.phones : [];
        if (phones.length === 0) {
          stats.projectsSkippedNoPhone += 1;
          return;
        }

        stats.projectsProcessed += 1;

        for (const phoneEntry of phones) {
          const normalized = cleanPhoneNumber(phoneEntry.number);
          if (!normalized) {
            continue;
          }

          try {
            await upsertCtmContact({ caseItem, client, phone: normalized });
            stats.contactsUpdated += 1;
          } catch (error) {
            stats.contactsFailedToAdd += 1;
            if (stats.unexpectedErrors < 5) {
              console.error("CTM upsert failed", {
                caseId: caseItem.projectId?.native || caseItem.projectId,
                phone: normalized,
                error: error.message,
              });
            }
            stats.unexpectedErrors += 1;
          }
        }
      });

      const nextLink = projectPage.links?.next;
      nextUrl = nextLink ? `${filevineBaseUrl}${nextLink}` : null;
    }

    console.log("sync-ctm completed", stats);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, stats }),
    };
  } catch (error) {
    console.error("sync-ctm failed", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: error.message, stats }),
    };
  }
};
