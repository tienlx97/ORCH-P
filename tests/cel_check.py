"""Evaluates an ORCH-P agent's orch_tool_allowlist CEL policy on sample events.

Usage: python3 -I tests/cel_check.py <agent config.yaml>  (cases as JSON on stdin)
Prints one decision per case: ALLOW (abstain), ASK or DENY, with the reason.
Needs cel-python and PyYAML (both ship with Omnigent); exit 3 when missing.
"""
import json
import sys

try:
    import celpy
    import yaml
except ImportError as error:
    print(f"missing: {error.name}", file=sys.stderr)
    sys.exit(3)

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
expression = config["guardrails"]["policies"]["orch_tool_allowlist"]["function"]["arguments"]["expression"]
env = celpy.Environment()
program = env.program(env.compile(expression))
out = []
for event in json.load(sys.stdin):
    result = program.evaluate({"event": celpy.json_to_cel(event)})
    key = celpy.celtypes.StringType("result")
    decision = str(result[key]) if key in result else "ALLOW"
    reason_key = celpy.celtypes.StringType("reason")
    out.append({"result": decision, "reason": str(result[reason_key]) if reason_key in result else None})
print(json.dumps(out))
