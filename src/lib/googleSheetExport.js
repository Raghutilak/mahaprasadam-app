const GOOGLE_EXPORT_URL =
  import.meta.env.VITE_GOOGLE_EXPORT_URL;

export async function exportToGoogleSheet(fromDate, toDate) {
  if (!GOOGLE_EXPORT_URL) {
    throw new Error(
      "Google Sheet export URL is not configured."
    );
  }

  const response = await fetch(GOOGLE_EXPORT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
    },
    body: JSON.stringify({
      fromDate,
      toDate,
    }),
  });

  const text = await response.text();

  console.log("Google export HTTP status:", response.status);
  console.log("Google export response:", text);

  if (!response.ok) {
    throw new Error(
      `Google export HTTP ${response.status}: ${text.substring(0, 200)}`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(
      "Google Sheet server returned HTML instead of JSON. " +
      "Check the Apps Script Web App deployment."
    );
  }

  if (!data.success) {
    throw new Error(
      data.error || "Google Sheet export failed."
    );
  }

  return data;
}