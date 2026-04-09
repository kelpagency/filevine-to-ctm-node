# filevine-to-ctm-node

Netlify function replacement for the archived Python `filevine-to-ctm` Cloud Function.

## Function

- `netlify/functions/sync-ctm.js`
- Scheduled with `@daily`
- Runs on published Netlify deploys in UTC

## What It Does

- Authenticates to Filevine using PAT credentials.
- Resolves the Filevine user and org context from the issued access token.
- Reads Filevine projects and client contacts.
- Normalizes contact phone numbers.
- Removes + re-adds numbers in a CTM contact list with project metadata.

## Environment Variables

See `.env.example`.

Required:

- `FILEVINE_ORG_ID`
- `FILEVINE_CLIENT_ID`
- `FILEVINE_CLIENT_SECRET`
- `FILEVINE_PAT_TOKEN`
- `CTM_ACCOUNT_ID`
- `CTM_CONTACT_LIST_ID`
- `CTM_BASIC_AUTH`

Optional:

- `FILEVINE_USER_ID`
  Kept only as a fallback/reference value. The code resolves the current Filevine user ID from the PAT token before making API requests, which avoids 403 errors after credential rotation.
- `FILEVINE_PAT_SCOPE`
- `FILEVINE_BASE_URL`
- `LOG_PROGRESS_EVERY`

## Validate

```bash
npm run check-auth
```
