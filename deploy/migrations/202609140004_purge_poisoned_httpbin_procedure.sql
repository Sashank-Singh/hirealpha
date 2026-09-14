-- The site-memory synthesizer used to store literal fill values in procedure
-- steps; the httpbin test runs poisoned the cache with a demo person's
-- details, which then replayed onto an unrelated run. Values are now never
-- stored (siteMemory.ts); this deletes the contaminated rows. Only httpbin
-- (pure test domain) is touched — no real merchant procedure had run yet.
DELETE FROM hire_site_procedures WHERE root_domain = 'httpbin.org';
