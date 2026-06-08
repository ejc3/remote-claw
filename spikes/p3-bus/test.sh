#!/usr/bin/env bash
# Drive the 4 §6B bus checks against a deployment.
# Usage: bash test.sh <deployment-url>
# Uses `vercel curl` so it works against protected (Vercel Authentication) deployments.
set -u
U="${1:?usage: bash test.sh <deployment-url>}"
T="bus:spk-$RANDOM$RANDOM"
vc() { vercel curl -s "$@" 2>/dev/null; }

echo "### token = $T"
echo "### CHECK 1 — wiring: publish 3 announces (resume-or-start the bus)"
for n in 1 2 3; do
  vc "$U/api/publish" -X POST -H "content-type: application/json" -d "{\"token\":\"$T\",\"msg\":{\"n\":$n}}"; echo
done
echo "### CHECK 1 — subscribe from 0 (expect n:1,2,3 + tailIndex)"
vc "$U/api/subscribe?token=$T&startIndex=0&ms=3000"; echo
echo "### CHECK 2 — negative startIndex=-2 (expect last 2)"
vc "$U/api/subscribe?token=$T&startIndex=-2&ms=3000"; echo
echo "### CHECK 3 — duplicate createHook on held token (expect HookConflictError)"
vc "$U/api/conflict" -X POST -H "content-type: application/json" -d "{\"token\":\"$T\"}"; echo
echo "### CHECK 4a — status BEFORE close (expect tokenResolves:true)"
vc "$U/api/status?token=$T"; echo
echo "### CHECK 4b — close the bus"
vc "$U/api/publish" -X POST -H "content-type: application/json" -d "{\"token\":\"$T\",\"msg\":{\"__close\":true}}"; echo
sleep 5
echo "### CHECK 4c — status AFTER close (expect tokenResolves:false; subscribe -> HookNotFound)"
vc "$U/api/status?token=$T"; echo
vc "$U/api/subscribe?token=$T&ms=1500"; echo
