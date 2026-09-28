# Post-run patch re-runs — EXCLUDED from the main scorecard

Two scenarios re-run at revision 8cad5aa (v2 claim refinements) after the main
78-scenario battery at 7133b5e. Mid-re-run the model provider returned
HTTP 402 Insufficient balance (instrument-degraded: one classifier call failed,
and lf1's final answer call fell back to the generic text). Their v1 (7133b5e)
transcripts were overwritten by these files.

The v1 evidence for both scenarios is preserved as text in
../out/digest-v1-2scenarios.txt and is what the scorecard scores. Do not mix
these files into aggregates.
