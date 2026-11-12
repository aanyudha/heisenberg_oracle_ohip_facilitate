Oracle source specifications, retained unmodified under Oracle's Universal Permissive License 1.0 (license embedded in each specification):

- `oracle-rsv-26.2.json`: https://raw.githubusercontent.com/oracle/hospitality-api-docs/26.2/rest-api-specs/property/v1/rsv.json
- `oracle-rsv-26.3.json`: https://raw.githubusercontent.com/oracle/hospitality-api-docs/26.3/rest-api-specs/property/v1/rsv.json
- `oracle-rsv-26.4.json`: https://raw.githubusercontent.com/oracle/hospitality-api-docs/v26.4/rest-api-specs/property/v1/rsv.json

Fetched 2026-10-27. The v26.4 release's RSV specification identifies itself as 26.3.0.0; this is not a claim that a separate RSV 26.4 contract exists.

`reservations.json` is synthetic, contains no real guest PII, and is validated by AJV against the official `reservationsDetails` definition for every retained release. Requests are validated against `searchHotelReservationsRequest`. The adapter requires a documented subset sufficient for the read model and fails closed for missing identifiers/stay dates.

OAuth: Oracle Hospitality's official OCIM example: https://www.postman.com/hospitalityapis/oracle-hospitality-apis/request/yvi8whu/get-oauth-token-for-client-credentials-environments

Release notes: https://github.com/oracle/hospitality-api-docs/releases

`oracle-hsk-26.3.json` is a **contract excerpt**, not a complete or modified production API payload. It retains the operation IDs/query parameters for `getHousekeepingOverview` and `getHouseKeepingTasks` and selected definitions from Oracle's [HSK 26.3 specification](https://github.com/oracle/hospitality-api-docs/blob/26.3/rest-api-specs/property/v1/hsk.json), retrieved 2026-11-12 under its Universal Permissive License. Tests pin the task GET's sequence-generation hazard and require `generateCleaningSequence=false`. Synthetic response builders in `tests/worksheet.test.ts` exercise safe mapping, pagination/permissions and removal of guest PII; they are never used as fallback live data.
