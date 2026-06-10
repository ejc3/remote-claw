// Scrub ambient RC_* vars from the developer's shell before any test runs. With RC_APP
// exported (e.g. left over from deploy work), runWrapper takes the real RC-launch path —
// bypassing injected spawn mocks and launching a REAL claude against a live broker.
// Tests that need an RC_* var set it explicitly (in-process or on the child env).
for (const key of Object.keys(process.env)) {
  if (key.startsWith("RC_")) delete process.env[key];
}
