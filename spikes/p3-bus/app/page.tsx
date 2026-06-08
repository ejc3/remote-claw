export default function Page() {
  return (
    <main style={{ fontFamily: "monospace", padding: 24 }}>
      <h1>remote-claw P3 spike</h1>
      <p>Verifies the §6B bus linchpins on real Vercel Workflows infra.</p>
      <ul>
        <li>POST /api/publish {`{token,msg}`} — resume-or-start the bus, deliver an announce</li>
        <li>GET /api/subscribe?token=&startIndex= — getHookByToken→getRun→getReadable</li>
        <li>POST /api/conflict {`{token}`} — duplicate createHook → HookConflictError</li>
        <li>GET /api/status?runId= — run status / hook resolvability</li>
      </ul>
    </main>
  );
}
