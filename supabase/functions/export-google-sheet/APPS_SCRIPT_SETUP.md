# Securing the Google Sheet export

The export now flows: browser → `export-google-sheet` Edge Function (checks
the caller is logged-in staff with export access) → your Apps Script URL
(server-side secret, never shipped to the browser) → your Sheet.

That closes the "anyone can read the URL out of the JS bundle" hole. As a
second layer — in case this URL is ever discovered another way (server
logs, a misconfigured proxy, etc.) — add a shared-secret check in the Apps
Script itself, so it refuses requests that don't know the secret.

## 1. Add this near the top of your Apps Script's `doPost(e)`

```js
function doPost(e) {
  const body = JSON.parse(e.postData.contents);

  const EXPECTED_SECRET = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  if (!EXPECTED_SECRET || body.sharedSecret !== EXPECTED_SECRET) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'Unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ... your existing export logic, using body.fromDate / body.toDate ...
}
```

## 2. Set the secret on the Apps Script side

In the Apps Script editor: **Project Settings → Script Properties → Add script property**
- Name: `SHARED_SECRET`
- Value: the exact same value you set for `GOOGLE_EXPORT_SHARED_SECRET` in
  Supabase (`supabase secrets set GOOGLE_EXPORT_SHARED_SECRET=...`).

## 3. Redeploy the Apps Script as a new Web App version

Existing deployments don't auto-update when you edit the code — use
**Deploy → Manage deployments → Edit → New version**.

## 4. Rotate the URL itself

The URL that was previously in `.env` (`VITE_...`) was shipped to every
browser that ever loaded the app. Treat it as already leaked: create a
**new** deployment (which gets a new URL) rather than reusing the old one,
and put only the new URL into the `GOOGLE_EXPORT_URL` Supabase secret.
