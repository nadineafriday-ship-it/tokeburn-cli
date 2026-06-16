"use strict";

/**
 * POST an ingest payload to the Tokeburn ingest endpoint.
 *
 * This is the single ingest path shared by the CLI (`tokeburn sync`) and the
 * SDK wrapper (`withTokeburn`). It is intentionally thin: it performs the HTTP
 * request and returns the `fetch` Response so the caller can decide what to do
 * with the result. It does no logging and swallows nothing — network failures
 * reject, and a non-2xx response comes back as a Response with `ok === false`.
 *
 * @param {object} payload   The payload object (see src/payload.js).
 * @param {object} opts
 * @param {string} opts.token   Tokeburn API token (sent as a Bearer token).
 * @param {string} opts.apiUrl  Ingest endpoint URL.
 * @returns {Promise<Response>}
 */
function postPayload(payload, { token, apiUrl } = {}) {
  return fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

module.exports = { postPayload };
